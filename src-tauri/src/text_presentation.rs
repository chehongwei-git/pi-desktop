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
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextPart {
    pub kind: String,
    pub id: String,
    pub text: String,
    pub chars: usize,
    pub content_ref: Option<String>,
    pub truncated: bool,
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
/// UTF-16 偏移与 DOM 一致；先映射到 UTF-8 字节边界，拒绝截断 emoji 和乱序范围。
pub fn slices<'a>(text: &'a str, ranges: &[TextRange]) -> Result<Vec<&'a str>> {
    let invalid = || AppError::new("TEXT_PARTS", "文本卡片范围无效，请还原文字后重试");
    if ranges.is_empty() || !ranges.iter().any(|p| p.kind == "paste") {
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
        if !["text", "paste"].contains(&part.kind.as_str())
            || part.id.is_empty()
            || !ids.insert(&part.id)
            || part.start != end
            || part.end < part.start
        {
            return Err(invalid());
        }
        let from = *boundaries.get(&part.start).ok_or_else(invalid)?;
        let to = *boundaries.get(&part.end).ok_or_else(invalid)?;
        result.push(&text[from..to]);
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
            .filter(|s| s.version == 1 && s.digest == hash && slices(&text, &s.ranges).is_ok());
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
                        version: 1,
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
        let Some(ranges) = ranges else {
            return Ok(None);
        };
        let Ok(texts) = slices(&text, &ranges) else {
            return Ok(None);
        };
        let mut parts = Vec::new();
        for (part, text) in ranges.iter().zip(texts) {
            let chars = text.chars().count();
            let limit = if part.kind == "paste" { 360 } else { 64 * 1024 };
            parts.push(TextPart {
                kind: part.kind.clone(),
                id: part.id.clone(),
                text: text.chars().take(limit).collect(),
                chars,
                content_ref: Some(store.body(text)?),
                truncated: chars > limit,
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
            },
            TextRange {
                kind: "paste".into(),
                id: "p".into(),
                start: 1,
                end: 4,
            },
        ]
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
