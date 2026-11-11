//! 用户文本展示元数据：独立于 Pi 历史，只在身份和全文校验一致时恢复卡片。
use crate::{history::text_content, storage::Store, types::*};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, path::PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TextRange {
    pub kind: String,
    pub id: String,
    pub start: usize,
    pub end: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub files: Option<Vec<FileReference>>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileReference {
    pub id: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub directory: Option<bool>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextPart {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skill: Option<SkillInfo>,
    pub kind: String,
    pub id: String,
    pub text: String,
    pub chars: usize,
    pub content_ref: Option<String>,
    pub truncated: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub files: Option<Vec<FileReference>>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInfo {
    pub name: String,
    pub location: String,
    pub text: String,
    pub content_ref: Option<String>,
    pub truncated: bool,
}
/// 只识别消息开头的标准包装；缺少闭合或出现嵌套标签时保留原文。
fn skill(text: &str) -> Option<(&str, &str, &str, usize)> {
    let rest = text.strip_prefix("<skill name=\"")?;
    let (name, rest) = rest.split_once("\" location=\"")?;
    let (location, rest) = rest.split_once("\">")?;
    if name.is_empty()
        || location.is_empty()
        || name.contains(['\n', '\r', '<', '>'])
        || location.contains(['\n', '\r', '<', '>'])
    {
        return None;
    }
    let newline = if rest.starts_with("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let body = rest.strip_prefix(newline)?;
    let (instructions, tail) = body.split_once(&format!("{newline}</skill>"))?;
    if instructions.contains("<skill ") || instructions.contains("</skill>") {
        return None;
    }
    let end = text.len() - tail.len();
    if !tail.is_empty() && !tail.starts_with(&format!("{newline}{newline}")) {
        return None;
    }
    Some((name, location, instructions, end))
}
#[derive(Serialize, Deserialize)]
struct Saved {
    version: u8,
    digest: String,
    ranges: Vec<TextRange>,
}
struct Pending {
    request: String,
    digest: String,
    ranges: Vec<TextRange>,
}
#[derive(Default)]
pub struct Presentations {
    root: Option<PathBuf>,
    session: String,
    pending: Vec<Pending>,
}
fn digest(text: &str, images: &Value) -> String {
    format!("{:x}", Sha256::digest(format!("{text}\0{images}")))
}
fn images(value: &Value) -> Value {
    json!(value
        .as_array()
        .into_iter()
        .flatten()
        .filter(|v| v["type"] == "image")
        .map(|v| json!({"type":"image", "mimeType":v["mimeType"], "data":v["data"]}))
        .collect::<Vec<_>>())
}
fn absolute(path: &str) -> bool {
    let bytes = path.as_bytes();
    !path.contains('\0')
        && (path.starts_with('/')
            || (bytes.len() >= 3
                && bytes[0].is_ascii_alphabetic()
                && bytes[1] == b':'
                && matches!(bytes[2], b'/' | b'\\'))
            || (path.starts_with("\\\\")
                && path[2..]
                    .split(['/', '\\'])
                    .filter(|s| !s.is_empty())
                    .count()
                    >= 2))
}
/// 旧消息只接受严格末尾格式；不把 Markdown 围栏或引用里的示例当成附件。
fn legacy(text: &str) -> Option<(usize, Vec<FileReference>)> {
    let (start, body) = if let Some(rest) = text.strip_prefix("文件引用：\n") {
        (0, rest)
    } else {
        let at = text.rfind("\n\n文件引用：\n")?;
        let prefix = &text[..at];
        let mut fence: Option<(char, usize)> = None;
        for line in prefix.lines() {
            let trimmed = line.trim_start();
            let c = trimmed.chars().next().unwrap_or(' ');
            let count = trimmed.chars().take_while(|ch| *ch == c).count();
            if (c == '`' || c == '~') && count >= 3 {
                match fence {
                    None => fence = Some((c, count)),
                    Some((open, len)) if open == c && count >= len => fence = None,
                    _ => {}
                }
            }
        }
        if fence.is_some() {
            return None;
        }
        (at, &text[at + "\n\n文件引用：\n".len()..])
    };
    let mut files = Vec::new();
    for (index, line) in body.split('\n').enumerate() {
        let path: String = serde_json::from_str(line).ok()?;
        if !absolute(&path) || serde_json::to_string(&path).ok()? != line {
            return None;
        }
        files.push(FileReference {
            id: format!("legacy-{index}"),
            path,
            directory: None,
        });
    }
    (!files.is_empty()).then_some((start, files))
}
/// UTF-16 偏移与 DOM 一致；先映射到 UTF-8 字节边界，拒绝截断 emoji 和乱序范围。
pub fn slices<'a>(text: &'a str, ranges: &[TextRange]) -> Result<Vec<&'a str>> {
    let invalid = || AppError::new("TEXT_PARTS", "文本卡片范围无效，请还原文字后重试");
    if ranges.is_empty()
        || !ranges
            .iter()
            .any(|p| p.kind == "paste" || p.kind == "files")
    {
        return Err(invalid());
    }
    let mut boundaries = std::collections::HashMap::new();
    let mut units = 0;
    boundaries.insert(0, 0);
    for (byte, ch) in text.char_indices() {
        units += ch.len_utf16();
        boundaries.insert(units, byte + ch.len_utf8());
    }
    let mut end = 0;
    let mut ids = HashSet::new();
    let mut result = Vec::new();
    for part in ranges {
        if !["text", "paste", "files"].contains(&part.kind.as_str())
            || part.id.is_empty()
            || !ids.insert(&part.id)
            || part.start != end
            || part.end < part.start
        {
            return Err(invalid());
        }
        let from = *boundaries.get(&part.start).ok_or_else(invalid)?;
        let to = *boundaries.get(&part.end).ok_or_else(invalid)?;
        let slice = &text[from..to];
        if part.kind == "files" {
            let files = part
                .files
                .as_ref()
                .filter(|files| !files.is_empty())
                .ok_or_else(invalid)?;
            let mut file_ids = HashSet::new();
            let expected = format!(
                "{}文件引用：\n{}",
                if part.start == 0 { "" } else { "\n\n" },
                files
                    .iter()
                    .map(|f| serde_json::to_string(&f.path).unwrap_or_default())
                    .collect::<Vec<_>>()
                    .join("\n")
            );
            if part.end != units
                || slice != expected
                || files
                    .iter()
                    .any(|f| f.id.is_empty() || !file_ids.insert(&f.id) || !absolute(&f.path))
            {
                return Err(invalid());
            }
        } else if part.files.is_some() {
            return Err(invalid());
        }
        result.push(slice);
        end = part.end;
    }
    if end != units {
        return Err(invalid());
    }
    Ok(result)
}
impl Presentations {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root: Some(root),
            ..Self::default()
        }
    }
    pub fn context(&mut self, path: &str) {
        // 路径身份与项目会话索引使用相同的平台规则。
        let path = crate::session_identity(path).unwrap_or_else(|_| path.into());
        if self.session != path {
            self.session = path;
            self.pending.clear();
        }
    }
    pub fn prepare(
        &mut self,
        request: String,
        command: &Value,
        ranges: Vec<TextRange>,
    ) -> Result<()> {
        let text = command["message"].as_str().unwrap_or("");
        slices(text, &ranges)?;
        self.pending.push(Pending {
            request,
            digest: digest(text, &images(&command["images"])),
            ranges,
        });
        Ok(())
    }
    pub fn reject(&mut self, request: &str) {
        self.pending.retain(|p| p.request != request);
    }
    pub fn clear(&mut self) {
        self.pending.clear();
    }
    pub fn project(
        &mut self,
        value: &Value,
        live: bool,
        store: &mut Store,
    ) -> Result<Option<Vec<TextPart>>> {
        if value["role"] != "user" {
            return Ok(None);
        }
        let text = text_content(&value["content"]);
        // 在消息预览截断前切分，确保技能再长也不会吞掉用户任务；不写入 Pi 历史。
        if let Some((name, location, instructions, end)) = skill(&text) {
            let mut parts = vec![TextPart {
                kind: "skill".into(),
                id: "skill".into(),
                text: String::new(),
                chars: text[..end].chars().count(),
                content_ref: Some(store.body(&text[..end])?),
                truncated: true,
                files: None,
                skill: Some(SkillInfo {
                    name: name.into(),
                    location: location.into(),
                    text: String::new(),
                    content_ref: Some(store.body(instructions)?),
                    truncated: true,
                }),
            }];
            if end < text.len() {
                let tail = &text[end..];
                parts.push(TextPart {
                    kind: "text".into(),
                    id: "skill-request".into(),
                    text: tail.chars().take(64 * 1024).collect(),
                    chars: tail.chars().count(),
                    content_ref: Some(store.body(tail)?),
                    truncated: tail.chars().count() > 64 * 1024,
                    files: None,
                    skill: None,
                });
            }
            return Ok(Some(parts));
        }
        let hash = digest(&text, &images(&value["content"]));
        // 原始时间戳在实时事件和 get_entries 中保持不变；不使用运行时临时 message-N。
        let key = value["timestamp"]
            .as_i64()
            .filter(|_| !self.session.is_empty())
            .map(|time| {
                format!(
                    "{:x}",
                    Sha256::digest(format!("{}\0{time}\0{hash}", self.session))
                )
            });
        let path = self
            .root
            .as_ref()
            .zip(key)
            .map(|(root, key)| root.join(format!("{key}.json")));
        let saved = path
            .as_ref()
            .and_then(|p| std::fs::read(p).ok())
            .and_then(|data| serde_json::from_slice::<Saved>(&data).ok())
            .filter(|s| {
                [1, 2].contains(&s.version) && s.digest == hash && slices(&text, &s.ranges).is_ok()
            });
        if live && saved.is_some() && self.pending.iter().any(|p| p.digest == hash) {
            // 同一时间戳/正文的事件既可能是重放，也可能是新的重复提交，不能猜测绑定。
            self.pending.retain(|p| p.digest != hash);
            return Ok(None);
        }
        let ranges = if let Some(saved) = saved {
            Some(saved.ranges)
        } else if live {
            let matching: Vec<_> = self
                .pending
                .iter()
                .enumerate()
                .filter(|(_, p)| p.digest == hash)
                .map(|(i, _)| i)
                .collect();
            // 相同正文存在不同卡片布局时无法证明对应关系，宁可普通展示也不串内容。
            if matching.len() == 1 {
                let pending = self.pending.remove(matching[0]);
                if let Some(path) = path {
                    let saved = Saved {
                        version: 2,
                        digest: hash,
                        ranges: pending.ranges.clone(),
                    };
                    let persist = || -> std::io::Result<()> {
                        std::fs::create_dir_all(path.parent().unwrap())?;
                        let mut file = tempfile::NamedTempFile::new_in(path.parent().unwrap())?;
                        serde_json::to_writer(file.as_file_mut(), &saved)?;
                        file.as_file_mut().sync_all()?;
                        file.persist(&path).map_err(|e| e.error)?;
                        Ok(())
                    };
                    if persist().is_err() {
                        store.push(json!({"type":"notice","message":"文本卡片展示未能保存，重启后可能显示为普通文字；消息不会重复发送。"}))?;
                    }
                } else {
                    store.push(json!({"type":"notice","message":"消息缺少稳定身份，文本卡片暂时仅在本次会话显示。"}))?;
                }
                Some(pending.ranges)
            } else {
                if matching.len() > 1 {
                    self.pending.retain(|p| p.digest != hash);
                }
                None
            }
        } else {
            None
        };
        let mut ranges = ranges.unwrap_or_default();
        if !ranges.iter().any(|part| part.kind == "files") {
            if let Some((at, files)) = legacy(&text) {
                let start = text[..at].encode_utf16().count();
                let end = text.encode_utf16().count();
                if ranges.is_empty() {
                    if start > 0 {
                        ranges.push(TextRange {
                            kind: "text".into(),
                            id: "legacy-text".into(),
                            start: 0,
                            end: start,
                            files: None,
                        });
                    }
                    ranges.push(TextRange {
                        kind: "files".into(),
                        id: "legacy-files".into(),
                        start,
                        end,
                        files: Some(files),
                    });
                } else if let Some(last) = ranges.last_mut() {
                    if last.kind == "text" && last.start <= start && last.end == end {
                        last.end = start;
                        if last.start == last.end {
                            ranges.pop();
                        }
                        ranges.push(TextRange {
                            kind: "files".into(),
                            id: "legacy-files".into(),
                            start,
                            end,
                            files: Some(files),
                        });
                    }
                }
            }
        }
        if ranges.is_empty() {
            return Ok(None);
        }
        let Ok(texts) = slices(&text, &ranges) else {
            return Ok(None);
        };
        let mut parts = Vec::new();
        for (part, text) in ranges.iter().zip(texts) {
            let chars = text.chars().count();
            let limit = if part.kind == "paste" { 360 } else { 64 * 1024 };
            parts.push(TextPart {
                skill: None,
                kind: part.kind.clone(),
                id: part.id.clone(),
                text: text.chars().take(limit).collect(),
                chars,
                content_ref: Some(store.body(text)?),
                truncated: chars > limit,
                files: part.files.clone(),
            });
        }
        Ok(Some(parts))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn ranges() -> Vec<TextRange> {
        vec![
            TextRange {
                kind: "text".into(),
                id: "t".into(),
                start: 0,
                end: 1,
                files: None,
            },
            TextRange {
                kind: "paste".into(),
                id: "p".into(),
                start: 1,
                end: 4,
                files: None,
            },
        ]
    }
    #[test]
    fn skill_projection_is_bounded_and_preserves_request_and_raw_parts() {
        for newline in ["\n", "\r\n"] {
            for location in ["/skills/中文/SKILL.md", "C:\\skills\\demo\\SKILL.md"] {
                let instructions = "规则😀".repeat(30_000);
                let text = format!("<skill name=\"demo\" location=\"{location}\">{newline}{instructions}{newline}</skill>{newline}{newline}请整理文档");
                let mut store = Store::new().unwrap();
                let mut p = Presentations::default();
                for live in [false, true] {
                    let parts = p
                        .project(&json!({"role":"user", "content":text}), live, &mut store)
                        .unwrap()
                        .unwrap();
                    assert_eq!(parts.len(), 2);
                    assert!(parts[0].text.is_empty());
                    assert_eq!(parts[0].skill.as_ref().unwrap().location, location);
                    assert_eq!(parts[1].text, format!("{newline}{newline}请整理文档"));
                    assert!(parts.iter().all(|part| part.content_ref.is_some()));
                }
                assert!(p
                    .project(
                        &json!({"role":"assistant", "content":text}),
                        false,
                        &mut store
                    )
                    .unwrap()
                    .is_none());
            }
        }
    }
    #[test]
    fn skill_parser_rejects_examples_and_malformed_blocks() {
        let valid = "<skill name=\"demo\" location=\"/skills/SKILL.md\">\n规则\n</skill>";
        assert_eq!(skill(valid).unwrap().2, "规则");
        for text in [
            format!("```\n{valid}\n```"),
            format!("示例：{valid}"),
            valid.replace("</skill>", ""),
            format!("{valid}unexpected"),
            valid.replace("规则", "<skill name=\"nested\">"),
            valid.replace("demo", ""),
        ] {
            assert!(skill(&text).is_none(), "{text}");
        }
    }
    #[test]
    fn validates_unicode_and_full_coverage() {
        assert_eq!(slices("前😀后", &ranges()).unwrap(), vec!["前", "😀后"]);
        let mut bad = ranges();
        bad[0].end = 2;
        bad[1].start = 2;
        assert!(slices("前😀后", &bad).is_err());
        bad = ranges();
        bad[1].end = 3;
        assert!(slices("前😀后", &bad).is_err());
    }
    #[test]
    fn saves_per_session_and_restores_without_matching_unrelated_messages() {
        let root = tempfile::tempdir().unwrap();
        let mut store = Store::new().unwrap();
        let mut p = Presentations::new(root.path().into());
        p.context("session-a");
        let cmd = json!({"message":"前😀后"});
        p.prepare("req".into(), &cmd, ranges()).unwrap();
        let value = json!({"role":"user","timestamp":123,"content":"前😀后"});
        let parts = p.project(&value, true, &mut store).unwrap().unwrap();
        assert_eq!(parts[1].chars, 2);
        let mut restored = Presentations::new(root.path().into());
        restored.context("session-a");
        assert!(restored
            .project(&value, false, &mut store)
            .unwrap()
            .is_some());
        restored.context("session-b");
        assert!(restored
            .project(&value, false, &mut store)
            .unwrap()
            .is_none());
        p.prepare("reject".into(), &cmd, ranges()).unwrap();
        p.reject("reject");
        let other = json!({"role":"user","timestamp":456,"content":"前😀后"});
        assert!(p.project(&other, true, &mut store).unwrap().is_none());
    }
    #[test]
    fn legacy_file_references_are_strict_and_preserve_long_pastes() {
        let root = tempfile::tempdir().unwrap();
        let mut store = Store::new().unwrap();
        let mut presentation = Presentations::new(root.path().into());
        let text = "说明\n\n文件引用：\n\"/tmp/文档.pdf\"\n\"C:\\\\work\\\\a.txt\"";
        let parts = presentation
            .project(&json!({"role":"user","content":text}), false, &mut store)
            .unwrap()
            .unwrap();
        assert_eq!(parts.last().unwrap().files.as_ref().unwrap().len(), 2);
        for bad in [
            "说明\n\n文件引用：\n\"relative\"",
            "```\n\n文件引用：\n\"/tmp/a\"",
            "文件引用：\n\"/tmp/a\"\nextra",
            "> 文件引用：\n> \"/tmp/a\"",
        ] {
            assert!(legacy(bad).is_none(), "{bad}");
        }
        assert!(presentation
            .project(
                &json!({"role":"assistant","content":text}),
                false,
                &mut store
            )
            .unwrap()
            .is_none());
    }
    #[test]
    fn rejects_files_metadata_that_does_not_match_sent_text() {
        let text = "说明\n\n文件引用：\n\"/tmp/a\"";
        let mut ranges = vec![
            TextRange {
                kind: "text".into(),
                id: "text".into(),
                start: 0,
                end: 2,
                files: None,
            },
            TextRange {
                kind: "files".into(),
                id: "files".into(),
                start: 2,
                end: text.encode_utf16().count(),
                files: Some(vec![FileReference {
                    id: "a".into(),
                    path: "/tmp/a".into(),
                    directory: Some(false),
                }]),
            },
        ];
        assert!(slices(text, &ranges).is_ok());
        ranges[1].files.as_mut().unwrap()[0].path = "/tmp/other".into();
        assert!(slices(text, &ranges).is_err());
    }
    #[test]
    fn ambiguous_pending_and_corrupt_storage_fall_back() {
        let root = tempfile::tempdir().unwrap();
        let mut store = Store::new().unwrap();
        let mut p = Presentations::new(root.path().into());
        p.context("session");
        for id in ["a", "b"] {
            p.prepare(id.into(), &json!({"message":"前😀后"}), ranges())
                .unwrap();
        }
        let value = json!({"role":"user","timestamp":1,"content":"前😀后"});
        assert!(p.project(&value, true, &mut store).unwrap().is_none());
        p.prepare("c".into(), &json!({"message":"前😀后"}), ranges())
            .unwrap();
        assert!(p.project(&value, true, &mut store).unwrap().is_some());
        for file in std::fs::read_dir(root.path()).unwrap() {
            std::fs::write(file.unwrap().path(), b"broken").unwrap();
        }
        assert!(p.project(&value, false, &mut store).unwrap().is_none());
    }
}
