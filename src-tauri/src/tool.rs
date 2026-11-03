//! 工具展示元数据：只投影 UI 需要的字段；大参数、写入内容和 diff 仍由宿主管理。
use crate::{
    storage::{preview, Store},
    types::Result,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolPresentation {
    pub call_id: String,
    pub name: String,
    pub command: Option<String>,
    pub path: Option<String>,
    pub offset: Option<u64>,
    pub limit: Option<u64>,
    pub args_ref: Option<String>,
    pub write_ref: Option<String>,
    pub diff_ref: Option<String>,
    pub diff_preview: String,
    pub diff_lines: usize,
    #[serde(default)]
    pub added_lines: Option<usize>,
    #[serde(default)]
    pub removed_lines: Option<usize>,
    pub tail: String,
    pub output_lines: usize,
    pub truncation: Option<Value>,
    pub full_output_path: Option<String>,
}
impl ToolPresentation {
    pub fn call(id: &str, name: &str, args: &Value, store: &mut Store) -> Result<Self> {
        Ok(Self {
            call_id: id.into(),
            name: name.into(),
            command: args["command"].as_str().map(|s| preview(s, 4096)),
            path: args["path"]
                .as_str()
                .or_else(|| args["file_path"].as_str())
                .map(|s| preview(s, 4096)),
            offset: args["offset"].as_u64(),
            limit: args["limit"].as_u64(),
            args_ref: if args.is_null() {
                None
            } else {
                Some(store.body(&serde_json::to_string_pretty(args).unwrap_or_default())?)
            },
            write_ref: if name == "write" {
                args["content"]
                    .as_str()
                    .map(|s| store.body(s))
                    .transpose()?
            } else {
                None
            },
            // 纯写入按全部新增展示；若结果提供实际 diff，result 中以 diff 统计覆盖。
            added_lines: if name == "write" {
                args["content"].as_str().map(|text| text.lines().count())
            } else {
                None
            },
            removed_lines: if name == "write" && args["content"].is_string() {
                Some(0)
            } else {
                None
            },
            ..Self::default()
        })
    }
    pub fn result(&mut self, text: &str, details: &Value, store: &mut Store) -> Result<()> {
        self.output_lines = text.lines().count();
        // 末尾预览必须来自真正的结果尾部，而非 64KiB 头部预览。
        let lines = text.lines().rev().take(5).collect::<Vec<_>>();
        let tail = lines.into_iter().rev().collect::<Vec<_>>().join("\n");
        let mut start = tail.len().saturating_sub(16 * 1024);
        while !tail.is_char_boundary(start) {
            start += 1;
        }
        self.tail = tail[start..].into();
        if let Some(diff) = details["diff"].as_str() {
            self.diff_ref = Some(store.body(diff)?);
            self.diff_preview = preview(
                &diff.lines().take(10).collect::<Vec<_>>().join("\n"),
                16 * 1024,
            );
            self.diff_lines = diff.lines().count();
            // 基于完整正文统计，排除统一 diff 的文件头，兼容 Pi 自带行号格式。
            self.added_lines = Some(
                diff.lines()
                    .filter(|line| line.starts_with('+') && !line.starts_with("+++"))
                    .count(),
            );
            self.removed_lines = Some(
                diff.lines()
                    .filter(|line| line.starts_with('-') && !line.starts_with("---"))
                    .count(),
            );
        }
        if details["truncation"].is_object() {
            let t = &details["truncation"];
            self.truncation = Some(json!({
                "truncated": t["truncated"].as_bool().unwrap_or(false),
                "truncatedBy": t["truncatedBy"].as_str().map(|s| preview(s, 32)),
                "outputLines": t["outputLines"].as_u64(), "totalLines": t["totalLines"].as_u64(),
                "maxBytes": t["maxBytes"].as_u64(), "maxLines": t["maxLines"].as_u64(),
                "firstLineExceedsLimit": t["firstLineExceedsLimit"].as_bool()
            }));
        }
        if let Some(path) = details["fullOutputPath"].as_str() {
            self.full_output_path = Some(preview(path, 4096));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pure_writes_count_all_content_as_additions() {
        let mut store = Store::new().unwrap();
        for (text, count) in [
            ("", 0),
            ("一行", 1),
            ("a\nb\n", 2),
            ("a\r\nb\r\n", 2),
            ("a\n\n", 2),
        ] {
            let mut tool =
                ToolPresentation::call("write", "write", &json!({"content": text}), &mut store)
                    .unwrap();
            tool.result("Successfully wrote", &Value::Null, &mut store)
                .unwrap();
            assert_eq!(tool.added_lines, Some(count));
            assert_eq!(tool.removed_lines, Some(0));
        }
    }
    #[test]
    fn counts_full_diff_and_preserves_history_compatibility() {
        let mut store = Store::new().unwrap();
        let mut tool = ToolPresentation::default();
        let diff = format!(
            "--- a/file\r\n+++ b/file\r\n-1 old\r\n{}",
            (0..100)
                .map(|i| format!("+{} new\n", i + 1))
                .collect::<String>()
        );
        tool.result("成功", &json!({"diff": diff}), &mut store)
            .unwrap();
        assert_eq!(tool.added_lines, Some(100));
        assert_eq!(tool.removed_lines, Some(1));
        assert!(tool.diff_preview.lines().count() <= 10);
        let mut value = serde_json::to_value(&tool).unwrap();
        value.as_object_mut().unwrap().remove("addedLines");
        value.as_object_mut().unwrap().remove("removedLines");
        let old: ToolPresentation = serde_json::from_value(value).unwrap();
        assert_eq!(old.added_lines, None);
        assert_eq!(old.removed_lines, None);
    }
}
