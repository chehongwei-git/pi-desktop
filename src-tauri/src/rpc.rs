//! RPC 适配与展示投影：保持协议正文在宿主，组件只接触稳定业务事件。
use crate::{
    history::{active_branch, text_content},
    storage::{preview, Store},
    tool::ToolPresentation,
    types::{AppError, Message, MessageImage, ProcessInfo, Result},
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
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

/// 树菜单使用平铺节点摘要，避免随会话长度增长的 JSON 嵌套与完整正文 IPC。
pub fn tree_entries(data: &Value) -> Result<Value> {
    let entries = data["entries"]
        .as_array()
        .ok_or_else(|| AppError::new("PROTOCOL", "Pi 树查询缺失 entries"))?;
    let nodes: Vec<Value> = entries
        .iter()
        .map(|entry| {
            let text = if entry["message"]["content"].is_null() {
                entry["summary"].as_str().unwrap_or("").to_string()
            } else {
                text_content(&entry["message"]["content"])
            };
            json!({"id":entry["id"], "parentId":entry["parentId"],
            "label":entry["message"]["role"].as_str().or(entry["type"].as_str()).unwrap_or("entry"),
            "text":preview(&text, 720)})
        })
        .collect();
    Ok(json!({"nodes":nodes,"leafId":data["leafId"]}))
}

/// 展示投影只维护当前分支；正文结束时卸载大文本。running 块仅在流式期间保留。
#[derive(Default)]
pub struct Projection {
    pub messages: Vec<Message>,
    active_id: Option<String>,
    blocks: BTreeMap<usize, (String, String)>,
    counter: u64,
    tools: BTreeMap<String, ToolPresentation>,
    process: Option<ProcessInfo>,
    timing_dir: Option<std::path::PathBuf>,
    message_started: Option<i64>,
    timing_keys: Vec<String>,
    waiting_extensions: BTreeSet<String>,
}

/// 只以消息时间戳和正文摘要生成键，文件名不暴露提示词或工作目录。
fn timing_key(value: &Value) -> Option<String> {
    let timestamp = value["timestamp"].as_i64()?;
    Some(format!(
        "v2-{:x}",
        Sha256::digest(format!("{timestamp}:{}", value["content"]).as_bytes())
    ))
}
impl Projection {
    /// 等待用户的扩展不能被进程池借走。
    pub fn waiting_for_extension(&self) -> bool {
        !self.waiting_extensions.is_empty()
    }
    /// 新会话或恢复成功后才能清空；取消切换不得调用。
    pub fn reset(&mut self) {
        self.messages.clear();
        self.blocks.clear();
        self.active_id = None;
        self.tools.clear();
        self.process = None;
        self.message_started = None;
        self.timing_keys.clear();
        self.waiting_extensions.clear();
    }
    /// 独立元数据文件不改写 Pi 历史；每条已结束消息只写一次，临时文件原子替换。
    pub fn with_timing_dir(path: std::path::PathBuf) -> Self {
        Self {
            timing_dir: Some(path),
            ..Self::default()
        }
    }
    fn begin_process(&mut self) {
        if self.process.as_ref().is_some_and(|p| p.ended_at.is_some()) {
            self.process = None;
            self.timing_keys.clear();
        }
        if self.process.is_none() {
            self.process = Some(ProcessInfo {
                id: uuid::Uuid::new_v4().to_string(),
                started_at: Some(chrono::Utc::now().timestamp_millis()),
                ended_at: None,
                paused_at: (!self.waiting_extensions.is_empty())
                    .then(|| chrono::Utc::now().timestamp_millis()),
                paused_ms: 0,
                state: "running".into(),
            });
        }
    }
    /// 普通正文开始即结束前一组，后续工具创建独立计时。
    fn finish_process(&mut self, store: &mut Store) -> Result<()> {
        if let Some(process) = &mut self.process {
            if process.ended_at.is_none() {
                process.ended_at = Some(chrono::Utc::now().timestamp_millis());
                process.state = "done".into();
            }
        }
        self.publish_process(store)?;
        for key in &self.timing_keys {
            self.save_timing_key(key);
        }
        Ok(())
    }
    /// 响应写入 Pi 成功后才解除等待，重复或过期 ID 不影响计时。
    pub fn extension_responded(&mut self, id: &str, store: &mut Store) -> Result<()> {
        if !self.waiting_extensions.remove(id) || !self.waiting_extensions.is_empty() {
            return Ok(());
        }
        if let Some(process) = &mut self.process {
            if let Some(paused_at) = process.paused_at.take() {
                let end = process.ended_at.unwrap_or_else(|| chrono::Utc::now().timestamp_millis());
                process.paused_ms += (end - paused_at).max(0);
            }
        }
        self.publish_process(store)?;
        for key in &self.timing_keys {
            self.save_timing_key(key);
        }
        Ok(())
    }
    fn publish_process(&mut self, store: &mut Store) -> Result<()> {
        // 所有结束路径统一结清当前暂停，避免停止后仍保留活动暂停状态。
        if let Some(process) = &mut self.process {
            if let (Some(end), Some(start)) = (process.ended_at, process.paused_at) {
                process.paused_ms += (end - start).max(0);
                process.paused_at = None;
            }
        }
        if let Some(process) = &self.process {
            for message in &mut self.messages {
                if message.process.as_ref().is_some_and(|p| p.id == process.id) {
                    message.process = Some(process.clone());
                    store.push(json!({"type":"message","message":message}))?;
                }
            }
        }
        Ok(())
    }
    fn save_timing(&self, value: &Value) {
        let Some(key) = timing_key(value) else {
            return;
        };
        self.save_timing_key(&key);
    }
    fn save_timing_key(&self, key: &str) {
        let Some(dir) = &self.timing_dir else {
            return;
        };
        let Some(process) = &self.process else {
            return;
        };
        let result = (|| -> std::io::Result<()> {
            std::fs::create_dir_all(dir)?;
            let mut file = tempfile::NamedTempFile::new_in(dir)?;
            serde_json::to_writer(&mut file, process)?;
            file.persist(dir.join(format!("{key}.json")))
                .map_err(|e| e.error)?;
            Ok(())
        })();
        if result.is_err() {
            tracing::warn!(
                code = "PROCESS_TIMING_WRITE",
                "process timing not persisted"
            );
        }
    }
    fn calls(&mut self, value: &Value, store: &mut Store) -> Result<()> {
        if let Some(blocks) = value["content"].as_array() {
            for block in blocks.iter().filter(|b| b["type"] == "toolCall") {
                if let (Some(id), Some(name)) = (block["id"].as_str(), block["name"].as_str()) {
                    if !self.tools.contains_key(id) {
                        self.tools.insert(
                            id.into(),
                            ToolPresentation::call(id, name, &block["arguments"], store)?,
                        );
                    }
                }
            }
        }
        Ok(())
    }
    /// 全文大于预览阈值时存为私有引用；最终完整消息始终覆盖增量拼接。
    fn message(&mut self, value: &Value, id: String, store: &mut Store) -> Result<Message> {
        self.calls(value, store)?;
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
        let tool = if role == "toolResult" {
            let call_id = value["toolCallId"].as_str().unwrap_or("unknown");
            let mut tool = self
                .tools
                .get(call_id)
                .cloned()
                .unwrap_or_else(|| ToolPresentation {
                    call_id: call_id.into(),
                    name: value["toolName"].as_str().unwrap_or("工具").into(),
                    ..Default::default()
                });
            tool.result(&text, &value["details"], store)?;
            self.tools.insert(call_id.into(), tool.clone());
            Some(tool)
        } else {
            None
        };
        // 图片不进入消息预览或事件正文，仅保留受控存储引用。
        let mut images = vec![];
        if role == "user" {
            for block in value["content"].as_array().into_iter().flatten() {
                if block["type"] != "image" {
                    continue;
                }
                let mime = block["mimeType"].as_str().unwrap_or("");
                let data = block["data"].as_str().unwrap_or("");
                if !["image/png", "image/jpeg", "image/webp", "image/gif"].contains(&mime)
                    || data.is_empty()
                {
                    continue;
                }
                images.push(MessageImage {
                    id: format!("{:x}", Sha256::digest(data.as_bytes())),
                    mime_type: mime.into(),
                    content_ref: store.body(data)?,
                });
            }
        }
        Ok(Message {
            id,
            images,
            // 展示按内容拆分，toolUse 不隐藏同消息的普通正文。
            presentation: (role == "assistant").then(|| "answer".into()),
            process: self.process.clone(),
            role,
            text: preview(&text, 64 * 1024),
            thinking: preview(&thinking, 64 * 1024),
            content_ref,
            truncated: text.len() > 64 * 1024,
            status: if value["isError"] == true || value["stopReason"] == "error" {
                "error"
            } else {
                "done"
            }
            .into(),
            name: tool
                .as_ref()
                .map(|t| t.name.clone())
                .or_else(|| value["toolName"].as_str().map(String::from)),
            tool,
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
                if self.process.as_ref().is_some_and(|p| p.state == "done") {
                    self.process = None;
                    self.timing_keys.clear();
                }
                self.begin_process();
                if let Some(process) = &mut self.process {
                    process.ended_at = None;
                    process.state = "running".into();
                }
                self.message_started = None;
                self.counter += 1;
                let id = format!("live-{}", self.counter);
                self.active_id = Some(id.clone());
                self.blocks.clear();
                self.upsert(
                    Message {
                        id,
                        role: "assistant".into(),
                        images: vec![],
                        text: String::new(),
                        thinking: String::new(),
                        presentation: Some("process".into()),
                        process: self.process.clone(),
                        content_ref: None,
                        truncated: false,
                        status: "streaming".into(),
                        name: None,
                        tool: None,
                    },
                    store,
                )?;
            }
            "message_update" => {
                let update = &event["assistantMessageEvent"];
                let update_kind = update["type"].as_str().unwrap_or("");
                if matches!(update_kind, "text_delta" | "thinking_delta") {
                    if update_kind == "text_delta"
                        && self.message_started.is_none()
                        && update["delta"]
                            .as_str()
                            .is_some_and(|text| !text.trim().is_empty())
                    {
                        self.finish_process(store)?;
                        self.message_started = Some(chrono::Utc::now().timestamp_millis());
                    }
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
                let mut message = self.message(value, id, store)?;
                if role == "assistant" {
                    if !message.text.trim().is_empty() {
                        self.finish_process(store)?;
                    }
                    if let Some(process) = &mut self.process {
                        if !message.text.trim().is_empty() {
                            process.ended_at = process.ended_at.or(self.message_started)
                                .or(Some(chrono::Utc::now().timestamp_millis()));
                            process.state = "done".into();
                        } else if matches!(value["stopReason"].as_str(), Some("error" | "aborted"))
                        {
                            process.ended_at = Some(chrono::Utc::now().timestamp_millis());
                            process.state = if value["stopReason"] == "aborted" {
                                "stopped"
                            } else {
                                "error"
                            }
                            .into();
                        }
                    }
                    self.publish_process(store)?;
                    message.process = self.process.clone();
                    if let Some(key) = timing_key(value) {
                        self.timing_keys.push(key);
                    }
                    self.save_timing(value);
                } else if role == "user" {
                    message.process = None;
                } else if role == "toolResult" {
                    // 工具结果保存独立映射，重启后仍可恢复该组计时。
                    if let Some(key) = timing_key(value) {
                        self.timing_keys.push(key);
                    }
                    self.save_timing(value);
                }
                self.upsert(message, store)?;
                self.blocks.clear();
            }
            "tool_execution_start" | "tool_execution_update" | "tool_execution_end" => {
                self.begin_process();
                let id = format!(
                    "tool-{}",
                    event["toolCallId"]
                        .as_str()
                        .ok_or_else(|| AppError::new("PROTOCOL", "工具事件缺失 ID"))?
                );
                let call_id = event["toolCallId"].as_str().unwrap_or("unknown");
                let name = event["toolName"].as_str().unwrap_or("工具");
                if kind == "tool_execution_start" {
                    self.tools.insert(
                        call_id.into(),
                        ToolPresentation::call(call_id, name, &event["args"], store)?,
                    );
                }
                let data = match kind {
                    "tool_execution_start" => &Value::Null,
                    "tool_execution_update" => &event["partialResult"],
                    _ => &event["result"],
                };
                let mut text = text_content(&data["content"]);
                if text.is_empty() && !data.is_null() && !data["content"].is_array() {
                    text = serde_json::to_string_pretty(data).unwrap_or_default();
                }
                let mut tool =
                    self.tools
                        .get(call_id)
                        .cloned()
                        .unwrap_or_else(|| ToolPresentation {
                            call_id: call_id.into(),
                            name: name.into(),
                            ..Default::default()
                        });
                tool.result(&text, &data["details"], store)?;
                self.tools.insert(call_id.into(), tool.clone());
                let content_ref = if !text.is_empty() && kind == "tool_execution_end" {
                    Some(store.body(&text)?)
                } else {
                    None
                };
                self.upsert(
                    Message {
                        id,
                        role: "toolResult".into(),
                        images: vec![],
                        text: preview(&text, 64 * 1024),
                        thinking: String::new(),
                        presentation: Some("process".into()),
                        process: self.process.clone(),
                        content_ref,
                        truncated: text.len() > 64 * 1024,
                        status: if kind != "tool_execution_end" {
                            "running"
                        } else if event["isError"] == true {
                            "error"
                        } else {
                            "done"
                        }
                        .into(),
                        name: Some(tool.name.clone()),
                        tool: Some(tool),
                    },
                    store,
                )?;
            }
            "agent_start" => {
                self.process = None;
                self.timing_keys.clear();
                self.begin_process();
                store.push(json!({"type":"run","state":"running"}))?;
            }
            "agent_settled" => {
                if let Some(process) = &mut self.process {
                    if process.ended_at.is_none() {
                        process.ended_at = Some(chrono::Utc::now().timestamp_millis());
                        process.state = "stopped".into();
                    }
                }
                self.publish_process(store)?;
                for key in &self.timing_keys {
                    self.save_timing_key(key);
                }
                self.process = None;
                self.timing_keys.clear();
                store.push(json!({"type":"run","state":"idle"}))?;
            }
            "auto_retry_start" => store.push(json!({"type":"run","state":"retrying"}))?,
            "compaction_start" => store.push(json!({"type":"run","state":"compacting"}))?,
            "compaction_end" if event["reason"] == "manual" => {
                store.push(json!({"type":"run","state":"idle"}))?
            }
            "compaction_end" | "auto_retry_end" => {
                store.push(json!({"type":"run","state":"running"}))?
            }
            "extension_ui_request" => {
                if matches!(event["method"].as_str(), Some("select" | "confirm" | "input" | "editor")) {
                    if let Some(id) = event["id"].as_str() {
                        self.waiting_extensions.insert(id.into());
                        if let Some(process) = &mut self.process {
                            if process.ended_at.is_none() && process.paused_at.is_none() {
                                process.paused_at = Some(chrono::Utc::now().timestamp_millis());
                            }
                        }
                        self.publish_process(store)?;
                        for key in &self.timing_keys {
                            self.save_timing_key(key);
                        }
                    }
                }
                store.push(json!({"type":"extension","request":event}))?;
            }
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
            if self.process.as_ref().is_some_and(|p| p.state == "done") {
                self.process = None;
            }
            // 新记录恢复精确计时；旧记录只恢复分组，时间保持未知。
            if matches!(value["role"].as_str(), Some("assistant" | "toolResult")) {
                let saved =
                    self.timing_dir
                        .as_ref()
                        .zip(timing_key(&value))
                        .and_then(|(dir, key)| {
                            std::fs::read(dir.join(format!("{key}.json")))
                                .ok()
                                .and_then(|bytes| {
                                    serde_json::from_slice::<ProcessInfo>(&bytes).ok()
                                })
                        });
                if let Some(saved) = saved {
                    self.process = Some(saved);
                } else if self.process.is_none() {
                    self.process = Some(ProcessInfo {
                        id: id.clone(),
                        started_at: None,
                        ended_at: None,
                        paused_at: None,
                        paused_ms: 0,
                        state: "running".into(),
                    });
                }
            }
            let mut message = self.message(&value, id, store)?;
            if value["role"] == "user" {
                message.process = None;
            }
            if value["role"] == "assistant" && !message.text.trim().is_empty() {
                if let Some(process) = &mut self.process {
                    process.state = "done".into();
                }
                message.process = self.process.clone();
            }
            self.messages.push(message);
        }
        // 后续消息持有整组最终时间，反向同步到分页边界之前的过程消息。
        let mut groups = BTreeMap::new();
        for message in &self.messages {
            if let Some(process) = &message.process {
                groups.insert(process.id.clone(), process.clone());
            }
        }
        for message in &mut self.messages {
            if let Some(process) = &mut message.process {
                *process = groups[&process.id].clone();
                if process.state == "running" {
                    process.state = "stopped".into();
                }
            }
        }
        self.process = None;
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
    /// 重叠请求按等待区间扣除，重复响应与非交互通知不能提前恢复。
    #[test]
    fn extension_waiting_pauses_until_all_responses_are_written() {
        let mut projection = Projection::default();
        let mut store = Store::new().unwrap();
        projection.event(json!({"type":"agent_start"}), &mut store).unwrap();
        projection.event(json!({"type":"extension_ui_request","method":"setStatus","id":"status"}), &mut store).unwrap();
        assert!(projection.process.as_ref().unwrap().paused_at.is_none());
        for method in ["select", "confirm", "input", "editor"] {
            projection.event(json!({"type":"extension_ui_request","method":method,"id":method}), &mut store).unwrap();
        }
        let paused = chrono::Utc::now().timestamp_millis() - 5000;
        projection.process.as_mut().unwrap().paused_at = Some(paused);
        for id in ["unknown", "select", "select", "confirm", "input"] {
            projection.extension_responded(id, &mut store).unwrap();
            assert_eq!(projection.process.as_ref().unwrap().paused_at, Some(paused));
            assert_eq!(projection.process.as_ref().unwrap().paused_ms, 0);
        }
        projection.extension_responded("editor", &mut store).unwrap();
        let process = projection.process.as_ref().unwrap();
        assert!(process.paused_at.is_none());
        assert!(process.paused_ms >= 5000);
        let elapsed = process.paused_ms;
        projection.extension_responded("editor", &mut store).unwrap();
        assert_eq!(projection.process.as_ref().unwrap().paused_ms, elapsed);
    }

    /// 停止或失败也结清暂停，并沿原有元数据恢复，不计入离线时长。
    #[test]
    fn paused_timing_is_finalized_and_restored() {
        for finish in ["agent_settled", "error", "aborted"] {
            let dir = tempfile::tempdir().unwrap();
            let mut projection = Projection::with_timing_dir(dir.path().to_path_buf());
            let mut store = Store::new().unwrap();
            projection.event(json!({"type":"agent_start"}), &mut store).unwrap();
            let message = json!({"role":"assistant","timestamp":1000,"stopReason":"toolUse","content":[{"type":"thinking","thinking":"分析"}]});
            projection.event(json!({"type":"message_end","message":message}), &mut store).unwrap();
            projection.event(json!({"type":"extension_ui_request","method":"input","id":"q"}), &mut store).unwrap();
            projection.process.as_mut().unwrap().paused_at = Some(chrono::Utc::now().timestamp_millis() - 5000);
            if finish == "agent_settled" {
                projection.event(json!({"type":finish}), &mut store).unwrap();
            } else {
                let mut failed = message.clone();
                failed["stopReason"] = finish.into();
                projection.event(json!({"type":"message_end","message":failed}), &mut store).unwrap();
            }
            let original = projection.messages.last().unwrap().process.as_ref().unwrap();
            assert!(original.paused_at.is_none());
            assert!(original.paused_ms >= 5000);
            assert!(original.ended_at.is_some());
            let mut restored = Projection::with_timing_dir(dir.path().to_path_buf());
            restored.restore(&json!({"leafId":"a","entries":[{"id":"a","type":"message","message":message}]}), &mut store).unwrap();
            let saved = restored.messages[0].process.as_ref().unwrap();
            assert_eq!(saved.paused_ms, original.paused_ms);
            assert_eq!(saved.ended_at, original.ended_at);
            assert!(saved.paused_at.is_none());
        }
        let legacy: ProcessInfo = serde_json::from_value(json!({"id":"old","startedAt":1,"endedAt":10,"state":"done"})).unwrap();
        assert_eq!(legacy.paused_ms, 0);
        assert!(legacy.paused_at.is_none());
    }

    /// 重启后复用同一组冻结时间；旧会话缺少记录不推算耗时。
    #[test]
    fn process_classification_and_timing_survive_restart() {
        let dir = tempfile::tempdir().unwrap();
        let mut projection = Projection::with_timing_dir(dir.path().to_path_buf());
        let mut store = Store::new().unwrap();
        let progress = json!({"role":"assistant","timestamp":1000,"stopReason":"toolUse","content":[{"type":"text","text":"检查文件"},{"type":"toolCall","id":"a","name":"read","arguments":{"path":"a"}}]});
        let answer = json!({"role":"assistant","timestamp":24000,"stopReason":"stop","content":[{"type":"thinking","thinking":"分析"},{"type":"text","text":"已完成"}]});
        projection
            .event(json!({"type":"agent_start"}), &mut store)
            .unwrap();
        projection
            .event(json!({"type":"message_end","message":progress}), &mut store)
            .unwrap();
        assert_eq!(
            projection.messages[0].presentation.as_deref(),
            Some("answer")
        );
        projection
            .event(
                json!({"type":"message_start","message":{"role":"assistant"}}),
                &mut store,
            )
            .unwrap();
        projection.event(json!({"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":1,"delta":"已完成"}}), &mut store).unwrap();
        projection
            .event(json!({"type":"message_end","message":answer}), &mut store)
            .unwrap();
        projection
            .event(json!({"type":"agent_settled"}), &mut store)
            .unwrap();
        let original = projection.messages[0].process.clone().unwrap();
        assert!(original.ended_at.is_some());
        let history = json!({"leafId":"b","entries":[
            {"id":"a","type":"message","message":progress},
            {"id":"b","parentId":"a","type":"message","message":answer}
        ]});
        let mut restarted = Projection::with_timing_dir(dir.path().to_path_buf());
        restarted.restore(&history, &mut store).unwrap();
        assert_eq!(
            restarted.messages[1].presentation.as_deref(),
            Some("answer")
        );
        for (message, live) in restarted.messages.iter().zip(&projection.messages) {
            let restored = message.process.as_ref().unwrap();
            let expected = live.process.as_ref().unwrap();
            assert_eq!(restored.id, expected.id);
            assert_eq!(restored.started_at, expected.started_at);
            assert_eq!(restored.ended_at, expected.ended_at);
        }
        assert_ne!(
            restarted.messages[0].process.as_ref().unwrap().id,
            restarted.messages[1].process.as_ref().unwrap().id
        );
        let mut legacy = Projection::default();
        legacy.restore(&history, &mut store).unwrap();
        assert!(legacy.messages[0]
            .process
            .as_ref()
            .unwrap()
            .started_at
            .is_none());
        assert_ne!(
            legacy.messages[0].process.as_ref().unwrap().id,
            legacy.messages[1].process.as_ref().unwrap().id
        );
    }
    /// 正文切断过程计时，工具独立组在历史恢复后仍保留正确起止时间。
    #[test]
    fn tools_between_visible_replies_have_independent_persistent_timing() {
        let dir = tempfile::tempdir().unwrap();
        let mut projection = Projection::with_timing_dir(dir.path().to_path_buf());
        let mut store = Store::new().unwrap();
        let first = json!({"role":"assistant","timestamp":1,"content":[{"type":"text","text":"先检查"},{"type":"toolCall","id":"r","name":"read","arguments":{}}],"stopReason":"toolUse"});
        let tool = json!({"role":"toolResult","timestamp":2,"toolCallId":"r","toolName":"read","content":[{"type":"text","text":"未找到"}],"isError":true});
        let last = json!({"role":"assistant","timestamp":3,"content":[{"type":"thinking","thinking":"换个路径"},{"type":"text","text":"检查完成"}],"stopReason":"stop"});
        projection
            .event(json!({"type":"agent_start"}), &mut store)
            .unwrap();
        projection
            .event(json!({"type":"message_end","message":first}), &mut store)
            .unwrap();
        projection
            .event(
                json!({"type":"tool_execution_start","toolCallId":"r","toolName":"read","args":{}}),
                &mut store,
            )
            .unwrap();
        projection
            .event(json!({"type":"message_end","message":tool}), &mut store)
            .unwrap();
        projection
            .event(
                json!({"type":"message_start","message":{"role":"assistant"}}),
                &mut store,
            )
            .unwrap();
        projection.event(json!({"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":1,"delta":"检查"}}), &mut store).unwrap();
        let frozen = projection.messages[1].process.clone().unwrap();
        assert_eq!(frozen.state, "done");
        assert!(frozen.ended_at.is_some());
        assert_ne!(
            frozen.id,
            projection.messages[0].process.as_ref().unwrap().id
        );
        projection
            .event(json!({"type":"message_end","message":last}), &mut store)
            .unwrap();
        projection
            .event(json!({"type":"agent_settled"}), &mut store)
            .unwrap();
        let history = json!({"leafId":"c","entries":[
            {"id":"a","type":"message","message":first},
            {"id":"b","parentId":"a","type":"message","message":tool},
            {"id":"c","parentId":"b","type":"message","message":last}
        ]});
        let mut restored = Projection::with_timing_dir(dir.path().to_path_buf());
        restored.restore(&history, &mut store).unwrap();
        assert_eq!(restored.messages[1].process.as_ref().unwrap().id, frozen.id);
        assert_eq!(
            restored.messages[1].process.as_ref().unwrap().ended_at,
            frozen.ended_at
        );
        assert_eq!(restored.messages[1].process.as_ref().unwrap().state, "done");
    }
    /// 图片只在宿主存正文，实时与恢复均保留摘要引用。
    #[test]
    fn user_images_survive_live_and_history_without_inline_data() {
        let mut projection = Projection::default();
        let mut store = Store::new().unwrap();
        let data = "a".repeat(100_000);
        let user =
            json!({"role":"user","content":[{"type":"image","mimeType":"image/png","data":data}]});
        projection
            .event(json!({"type":"message_end","message":user}), &mut store)
            .unwrap();
        let live = projection.messages[0].images[0].clone();
        assert!(
            serde_json::to_string(&projection.messages[0])
                .unwrap()
                .len()
                < 1024
        );
        assert_eq!(
            store.content(&live.content_ref, 0).unwrap()["text"]
                .as_str()
                .unwrap()
                .len(),
            65536
        );
        projection
            .restore(
                &json!({"entries":[{"id":"u","type":"message","message":user}],"leafId":"u"}),
                &mut store,
            )
            .unwrap();
        assert_eq!(projection.messages[0].images[0].id, live.id);
        assert!(projection.messages[0].text.is_empty());
    }
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
    /// 旧 get_tree 在约 40 个线性节点后便可能达到 serde_json 默认深度限制。
    #[tokio::test]
    async fn long_tree_uses_flat_entries_without_exceeding_json_depth() {
        let mut nested = "[]".to_string();
        for i in 0..100 {
            nested = format!(r#"[{{"entry":{{"id":"{i}"}},"children":{nested}}}]"#);
        }
        let wire = format!("{{\"type\":\"response\",\"data\":{{\"tree\":{nested}}}}}\n");
        let mut input = tokio::io::BufReader::new(wire.as_bytes());
        assert!(record(&mut input).await.is_err());
        let entries: Vec<Value> = (0..2000).map(|i| json!({
            "id":i.to_string(),"parentId":if i == 0 { None } else { Some((i-1).to_string()) },
            "type":"message","message":{"role":"user","content":"hello"}
        })).collect();
        let wire = format!("{}\n", json!({"entries":entries,"leafId":"1999"}));
        let mut input = tokio::io::BufReader::new(wire.as_bytes());
        let parsed = record(&mut input).await.unwrap().unwrap();
        let flat = tree_entries(&parsed).unwrap();
        assert_eq!(flat["nodes"].as_array().unwrap().len(), 2000);
        assert_eq!(flat["nodes"][1999]["parentId"], "1998");
        assert_eq!(flat["leafId"], "1999");
    }
    /// 正文引用用于缓存重载；只有超出 UTF-8 预览上限才需要显示全文入口。
    #[test]
    fn full_content_action_requires_truncated_body() {
        let mut projection = Projection::default();
        let mut store = Store::new().unwrap();
        for text in [
            "普通正文".to_string(),
            "a".repeat(64 * 1024),
            "你".repeat(64 * 1024 / 3 + 1),
        ] {
            let value = json!({"role":"assistant","content":[{"type":"text","text":text}]});
            let message = projection
                .message(&value, "message".into(), &mut store)
                .unwrap();
            assert!(message.content_ref.is_some());
            assert_eq!(message.truncated, text.len() > 64 * 1024);
            let page = store
                .content(message.content_ref.as_deref().unwrap(), 0)
                .unwrap();
            assert_eq!(page["done"], !message.truncated);
            assert_eq!(message.text, page["text"].as_str().unwrap());
            projection.event(json!({"type":"tool_execution_end","toolCallId":"tool","result":{"content":[{"type":"text","text":text}]}}), &mut store).unwrap();
            assert_eq!(
                projection.messages.last().unwrap().truncated,
                message.truncated
            );
        }
    }
    #[test]
    fn tool_metadata_survives_final_messages_and_history_restore() {
        let mut projection = Projection::default();
        let mut store = Store::new().unwrap();
        let args = json!({"path":"src/main.ts","edits":[{"oldText":"old","newText":"new"}]});
        let result = json!({"content":[{"type":"text","text":"编辑成功"}],"details":{"diff":"-1 old\n+1 new","firstChangedLine":1}});
        projection.event(json!({"type":"tool_execution_start","toolCallId":"edit-1","toolName":"edit","args":args}), &mut store).unwrap();
        projection.event(json!({"type":"tool_execution_end","toolCallId":"edit-1","toolName":"edit","result":result}), &mut store).unwrap();
        // 最后的持久化 toolResult 有可能没有 details，不能覆盖已收到的 diff。
        let final_message =
            json!({"role":"toolResult","toolCallId":"edit-1","content":result["content"]});
        projection
            .event(
                json!({"type":"message_end","message":final_message}),
                &mut store,
            )
            .unwrap();
        assert_eq!(projection.messages.len(), 1);
        let tool = projection.messages[0].tool.as_ref().unwrap();
        assert_eq!(tool.name, "edit");
        assert_eq!(tool.path.as_deref(), Some("src/main.ts"));
        assert_eq!(tool.diff_preview, "-1 old\n+1 new");
        assert!(tool.args_ref.is_some());
        assert_eq!(
            store.content(tool.diff_ref.as_deref().unwrap(), 0).unwrap()["text"],
            "-1 old\n+1 new"
        );
        let history = json!({"leafId":"b","entries":[
            {"id":"a","parentId":null,"type":"message","message":{"role":"assistant","content":[{"type":"toolCall","id":"edit-1","name":"edit","arguments":args}]}},
            {"id":"b","parentId":"a","type":"message","message":{"role":"toolResult","toolCallId":"edit-1","toolName":"edit","content":result["content"],"details":result["details"]}}
        ]});
        projection.restore(&history, &mut store).unwrap();
        let restored = projection.messages.last().unwrap().tool.as_ref().unwrap();
        assert_eq!(restored.path.as_deref(), Some("src/main.ts"));
        assert_eq!(restored.diff_preview, "-1 old\n+1 new");
        assert_eq!(restored.name, "edit");
        projection.reset();
        assert!(projection.tools.is_empty());
    }
    #[test]
    fn tool_tail_and_utf8_pages_preserve_output_and_truncation_details() {
        let mut projection = Projection::default();
        let mut store = Store::new().unwrap();
        let text = format!("{}\n真实结尾", "你".repeat(40000));
        projection.event(json!({"type":"tool_execution_start","toolCallId":"b","toolName":"bash","args":{"command":"echo output"}}), &mut store).unwrap();
        projection.event(json!({"type":"tool_execution_update","toolCallId":"b","toolName":"bash","partialResult":{"content":[{"type":"text","text":"部分输出"}]}}), &mut store).unwrap();
        projection.event(json!({"type":"tool_execution_end","toolCallId":"b","toolName":"bash","result":{"content":[{"type":"text","text":text}],"details":{"truncation":{"truncated":true,"truncatedBy":"bytes","maxBytes":120000},"fullOutputPath":"C:/tmp/full.txt"}}}), &mut store).unwrap();
        let message = projection.messages.last().unwrap();
        let tool = message.tool.as_ref().unwrap();
        assert!(message.truncated);
        assert!(tool.tail.ends_with("真实结尾"));
        assert!(tool.tail.len() <= 16 * 1024);
        assert_eq!(tool.command.as_deref(), Some("echo output"));
        assert_eq!(tool.truncation.as_ref().unwrap()["truncated"], true);
        assert_eq!(tool.full_output_path.as_deref(), Some("C:/tmp/full.txt"));
        let mut offset = 0;
        let mut all = String::new();
        loop {
            let page = store
                .content(message.content_ref.as_deref().unwrap(), offset)
                .unwrap();
            all.push_str(page["text"].as_str().unwrap());
            offset = page["next"].as_u64().unwrap() as usize;
            if page["done"] == true {
                break;
            }
        }
        assert_eq!(all, text);
    }
    #[test]
    fn write_parameters_are_references_and_empty_results_stay_empty() {
        let mut projection = Projection::default();
        let mut store = Store::new().unwrap();
        let content = "const written = true;\n".repeat(10000);
        projection.event(json!({"type":"tool_execution_start","toolCallId":"w","toolName":"write","args":{"path":"new.ts","content":content}}), &mut store).unwrap();
        let message = projection.messages.last().unwrap();
        assert!(message.text.is_empty());
        assert!(message.tool.as_ref().unwrap().write_ref.is_some());
        assert!(serde_json::to_string(message).unwrap().len() < 2048);
        projection.event(json!({"type":"tool_execution_end","toolCallId":"w","toolName":"write","result":{"content":[]}}), &mut store).unwrap();
        assert!(projection.messages.last().unwrap().text.is_empty());
    }
    /// accepted 与 agent_end 不是终点；只有 settled 才发布 idle。
    #[test]
    fn manual_compaction_finishes_without_agent_settled() {
        let mut projection = Projection::default();
        let mut store = Store::new().unwrap();
        projection
            .event(
                json!({"type":"compaction_start","reason":"manual"}),
                &mut store,
            )
            .unwrap();
        projection
            .event(
                json!({"type":"compaction_end","reason":"manual","willRetry":false}),
                &mut store,
            )
            .unwrap();
        assert_eq!(
            store.batch("r", 0).unwrap().events.last().unwrap()["state"],
            "idle"
        );
        projection
            .event(
                json!({"type":"compaction_end","reason":"threshold","willRetry":true}),
                &mut store,
            )
            .unwrap();
        assert_eq!(
            store.batch("r", 0).unwrap().events.last().unwrap()["state"],
            "running"
        );
    }
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
