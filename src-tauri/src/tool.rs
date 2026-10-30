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
