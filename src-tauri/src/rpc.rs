//! RPC 适配与展示投影：保持协议正文在宿主，组件只接触稳定业务事件。
use crate::{
    history::{active_branch, text_content},
    storage::{preview, Store},
    types::{AppError, Message, Result},
};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use tokio::io::{AsyncBufRead, AsyncBufReadExt};

pub const RECORD_LIMIT: usize = 64 * 1024 * 1024;
/// 按 LF 分帧，保留 U+2028/U+2029；逐块检查大小，防止无换行输出无限分配。
pub async fn record<R: AsyncBufRead + Unpin>(reader: &mut R) -> Result<Option<Value>> {
    let mut data = Vec::new();
    loop {
        let chunk = reader.fill_buf().await?;
        if chunk.is_empty() {
            if data.is_empty() {
                return Ok(None);
            }
            return Err(AppError::new("PROTOCOL", "Pi 输出了未完成的 JSONL 记录"));
        }
        let newline = chunk.iter().position(|&b| b == b'\n');
        let take = newline.map(|p| p + 1).unwrap_or(chunk.len());
        if data.len() + take > RECORD_LIMIT {
            return Err(AppError::new("RECORD_LIMIT", "Pi 单条记录超过 64 MiB"));
        }
        data.extend_from_slice(&chunk[..take]);
        reader.consume(take);
        if newline.is_some() {
            return serde_json::from_slice(&data).map(Some).map_err(|_| {
                AppError::new(
                    "PROTOCOL",
                    "Pi stdout 不是有效 JSONL；请检查扩展是否向 stdout 写日志",
                )
            });
        }
    }
}

/// 展示投影只维护当前分支；正文结束时卸载大文本。running 块仅在流式期间保留。
#[derive(Default)]
pub struct Projection {
    pub messages: Vec<Message>,
    active_id: Option<String>,
    blocks: BTreeMap<usize, (String, String)>,
    counter: u64,
}
impl Projection {
    /// 新会话或恢复成功后才能清空；取消切换不得调用。
    pub fn reset(&mut self) {
        self.messages.clear();
        self.blocks.clear();
        self.active_id = None;
    }
    /// 全文大于预览阈值时存为私有引用；最终完整消息始终覆盖增量拼接。
    fn message(&mut self, value: &Value, id: String, store: &mut Store) -> Result<Message> {
        let role = value["role"].as_str().unwrap_or("unknown").to_string();
        let mut text = if role == "compactionSummary" || role == "branchSummary" {
            value["summary"].as_str().unwrap_or("").into()
        } else {
            text_content(&value["content"])
        };
        if let Some(error) = value["errorMessage"]
            .as_str()
            .filter(|text| !text.is_empty())
        {
            if !text.is_empty() {
                text.push_str("\n\n");
            }
            text.push_str(error);
        }
        let thinking = value["content"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|v| v["thinking"].as_str())
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default();
        let content_ref = if !text.is_empty() {
            Some(store.body(&text)?)
        } else {
            None
        };
        Ok(Message {
            id,
            role,
            text: preview(&text, 64 * 1024),
            thinking: preview(&thinking, 64 * 1024),
            content_ref,
            status: if value["isError"] == true || value["stopReason"] == "error" {
                "error"
            } else {
                "done"
            }
            .into(),
            name: value["toolName"].as_str().map(String::from),
        })
    }
    /// 稳定 ID upsert，工具结果与执行结束不会在对话中重复显示。
    fn upsert(&mut self, message: Message, store: &mut Store) -> Result<()> {
        if let Some(index) = self.messages.iter().position(|m| m.id == message.id) {
            self.messages[index] = message.clone();
        } else {
            self.messages.push(message.clone());
        }
        store.push(json!({"type":"message","message":message}))
    }
    /// 生命周期与增量转换。未知事件只记录类型；不把原始正文传入日志。
    pub fn event(&mut self, event: Value, store: &mut Store) -> Result<()> {
        let kind = event["type"]
            .as_str()
            .ok_or_else(|| AppError::new("PROTOCOL", "事件缺失 type"))?;
        match kind {
            "message_start" if event["message"]["role"] == "assistant" => {
                self.counter += 1;
                let id = format!("live-{}", self.counter);
                self.active_id = Some(id.clone());
                self.blocks.clear();
                self.upsert(
                    Message {
                        id,
                        role: "assistant".into(),
                        text: String::new(),
                        thinking: String::new(),
                        content_ref: None,
                        status: "streaming".into(),
                        name: None,
                    },
                    store,
                )?;
            }
            "message_update" => {
                let update = &event["assistantMessageEvent"];
                let update_kind = update["type"].as_str().unwrap_or("");
                if matches!(update_kind, "text_delta" | "thinking_delta") {
                    let index = update["contentIndex"]
                        .as_u64()
                        .ok_or_else(|| AppError::new("PROTOCOL", "增量缺失 contentIndex"))?
                        as usize;
                    let delta = update["delta"]
                        .as_str()
                        .ok_or_else(|| AppError::new("PROTOCOL", "增量缺失 delta"))?;
                    let block = self
                        .blocks
                        .entry(index)
                        .or_insert_with(|| (update_kind.into(), String::new()));
                    if block.1.len() + delta.len() > RECORD_LIMIT {
                        return Err(AppError::new("RECORD_LIMIT", "流式内容块超过 64 MiB"));
                    }
                    block.1.push_str(delta);
                    if let Some(id) = &self.active_id {
                        store.push(json!({"type":"delta","id":id,"field":if update_kind=="text_delta" {"text"} else {"thinking"},"delta":delta}))?;
                    }
                }
            }
            "message_end" => {
                let value = &event["message"];
                let role = value["role"]
                    .as_str()
                    .ok_or_else(|| AppError::new("PROTOCOL", "消息缺失 role"))?;
                if role == "system" || (role == "custom" && value["display"] == false) {
                    return Ok(());
                }
                let id = if role == "assistant" {
                    self.active_id.take().unwrap_or_else(|| {
                        self.counter += 1;
                        format!("message-{}", self.counter)
                    })
                } else if role == "toolResult" {
                    format!("tool-{}", value["toolCallId"].as_str().unwrap_or("unknown"))
                } else {
                    self.counter += 1;
                    format!("message-{}", self.counter)
                };
                let message = self.message(value, id, store)?;
                self.upsert(message, store)?;
                self.blocks.clear();
            }
            "tool_execution_start" | "tool_execution_update" | "tool_execution_end" => {
                let id = format!(
                    "tool-{}",
                    event["toolCallId"]
                        .as_str()
                        .ok_or_else(|| AppError::new("PROTOCOL", "工具事件缺失 ID"))?
                );
                let data = match kind {
                    "tool_execution_start" => &event["args"],
                    "tool_execution_update" => &event["partialResult"],
                    _ => &event["result"],
                };
                let mut text = text_content(&data["content"]);
                if text.is_empty() {
                    text = serde_json::to_string_pretty(data).unwrap_or_default();
                }
                let content_ref = if !text.is_empty() && kind == "tool_execution_end" {
                    Some(store.body(&text)?)
                } else {
                    None
                };
                self.upsert(
                    Message {
                        id,
                        role: "toolResult".into(),
                        text: preview(&text, 64 * 1024),
                        thinking: String::new(),
                        content_ref,
                        status: if kind != "tool_execution_end" {
                            "running"
                        } else if event["isError"] == true {
                            "error"
                        } else {
                            "done"
                        }
                        .into(),
                        name: event["toolName"].as_str().map(String::from),
                    },
                    store,
                )?;
            }
            "agent_start" => store.push(json!({"type":"run","state":"running"}))?,
            "agent_settled" => store.push(json!({"type":"run","state":"idle"}))?,
            "auto_retry_start" => store.push(json!({"type":"run","state":"retrying"}))?,
            "compaction_start" => store.push(json!({"type":"run","state":"compacting"}))?,
            "compaction_end" | "auto_retry_end" => {
                store.push(json!({"type":"run","state":"running"}))?
            }
            "extension_ui_request" => store.push(json!({"type":"extension","request":event}))?,
            "session_info_changed" | "thinking_level_changed" | "queue_update" => {
                store.push(json!({"type":"metadata","data":event}))?
            }
            "extension_error" => {
                store.push(json!({"type":"notice","message":"Pi 扩展执行失败，请检查扩展配置"}))?
            }
            _ => {
                tracing::debug!(event_type = kind, "ignored RPC event");
            }
        }
        Ok(())
    }
    /// 全量 Pi 快照只在宿主短暂存在；沿当前 leaf 投影并卸载正文，再返回最后 50 条。
    pub fn restore(&mut self, data: &Value, store: &mut Store) -> Result<()> {
        let entries = data["entries"]
            .as_array()
            .ok_or_else(|| AppError::new("PROTOCOL", "Pi 不支持 get_entries，请检查版本"))?;
        let branch = active_branch(entries, data["leafId"].as_str());
        self.reset();
        for entry in branch {
            let mut value = entry["message"].clone();
            if entry["type"] == "compaction" {
                value = json!({"role":"compactionSummary","summary":entry["summary"]});
            }
            if value.is_null()
                || value["role"] == "system"
                || (value["role"] == "custom" && value["display"] == false)
            {
                continue;
            }
            let id = if value["role"] == "toolResult" {
                format!("tool-{}", value["toolCallId"].as_str().unwrap_or("unknown"))
            } else {
                entry["id"].as_str().unwrap_or("").into()
            };
            let message = self.message(&value, id, store)?;
            self.messages.push(message);
        }
        Ok(())
    }
    /// 历史分页游标是当前投影的数组位置，前端不需要接收完整快照。
    pub fn page(&self, before: Option<usize>) -> Value {
        let end = before
            .unwrap_or(self.messages.len())
            .min(self.messages.len());
        let start = end.saturating_sub(50);
        json!({"messages":self.messages[start..end],"before":start,"hasMore":start>0})
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    /// 半个 UTF-8 字符/CRLF/Unicode 分隔符均不能拆成额外协议记录。
    #[tokio::test]
    async fn framing_keeps_unicode_and_rejects_invalid() {
        let bytes = "{\"type\":\"x\",\"text\":\"你\u{2028}好\u{2029}\"}\r\n";
        let mut input = tokio::io::BufReader::with_capacity(2, bytes.as_bytes());
        assert_eq!(
            record(&mut input).await.unwrap().unwrap()["text"],
            "你\u{2028}好\u{2029}"
        );
        assert!(record(&mut input).await.unwrap().is_none());
        let mut bad = tokio::io::BufReader::new(&b"not-json\n"[..]);
        assert!(record(&mut bad).await.is_err());
    }
    /// accepted 与 agent_end 不是终点；只有 settled 才发布 idle。
    #[test]
    fn only_settled_ends_run() {
        let mut projection = Projection::default();
        let mut store = Store::new().unwrap();
        projection
            .event(json!({"type":"agent_start"}), &mut store)
            .unwrap();
        projection
            .event(json!({"type":"agent_end"}), &mut store)
            .unwrap();
        assert_eq!(store.batch("r", 0).unwrap().events.len(), 1);
        projection
            .event(json!({"type":"agent_settled"}), &mut store)
            .unwrap();
        assert_eq!(store.batch("r", 0).unwrap().events[1]["state"], "idle");
    }
}
