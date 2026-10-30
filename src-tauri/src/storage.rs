//! 会话期存储：事件可靠排队与大正文卸载。私有临时目录随运行实例回收。
use crate::types::{AppError, EventBatch, Result};
use serde_json::Value;
use std::{
    collections::{HashMap, VecDeque},
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
};

const LIMIT: u64 = 256 * 1024 * 1024;
/// 文件偏移索引不存正文；ack 之前可重复拉取同一批次，不会静默丢事件。
pub struct Store {
    _dir: tempfile::TempDir,
    events: File,
    bodies: File,
    queue: VecDeque<(u64, u64, usize)>,
    refs: HashMap<String, (u64, usize)>,
    next: u64,
    bytes: u64,
    event_end: u64,
    body_end: u64,
}
impl Store {
    /// tempfile 在当前用户临时目录创建随机私有目录；Drop 删除整个会话期副本。
    pub fn new() -> Result<Self> {
        let dir = tempfile::Builder::new().prefix("pi-desktop-").tempdir()?;
        let events = File::options()
            .create(true)
            .truncate(true)
            .read(true)
            .write(true)
            .open(dir.path().join("events"))?;
        let bodies = File::options()
            .create(true)
            .truncate(true)
            .read(true)
            .write(true)
            .open(dir.path().join("bodies"))?;
        Ok(Self {
            _dir: dir,
            events,
            bodies,
            queue: VecDeque::new(),
            refs: HashMap::new(),
            next: 0,
            bytes: 0,
            event_end: 0,
            body_end: 0,
        })
    }
    /// 是否仍有未确认记录；空闲时不向 WebView 持续发送唤醒。
    pub fn has_pending(&self) -> bool {
        !self.queue.is_empty()
    }
    /// 写入前检查总会话临时预算；超过上限是显式故障，绝不丢弃关键记录。
    fn reserve(&mut self, count: usize) -> Result<()> {
        if self.bytes + count as u64 > LIMIT {
            return Err(AppError::new(
                "STORAGE_LIMIT",
                "会话临时数据达到 256 MiB，请重新连接",
            ));
        }
        self.bytes += count as u64;
        Ok(())
    }
    /// 已确认事件可释放；全部排空时截断文件，避免健康长会话累积 spool。
    pub fn acknowledge(&mut self, sequence: u64) -> Result<()> {
        while self
            .queue
            .front()
            .is_some_and(|&(seq, _, _)| seq <= sequence)
        {
            if let Some((_, _, bytes)) = self.queue.pop_front() {
                self.bytes -= bytes as u64;
            }
        }
        if self.queue.is_empty() {
            self.events.set_len(0)?;
            self.event_end = 0;
        }
        Ok(())
    }
    /// 串行写入序号化事件；actor 是唯一写方，不需要文件锁。
    pub fn push(&mut self, event: Value) -> Result<()> {
        let data =
            serde_json::to_vec(&event).map_err(|_| AppError::new("SERIALIZE", "事件编码失败"))?;
        self.reserve(data.len())?;
        self.events.seek(SeekFrom::Start(self.event_end))?;
        self.events.write_all(&data)?;
        self.next += 1;
        self.queue
            .push_back((self.next, self.event_end, data.len()));
        self.event_end += data.len() as u64;
        Ok(())
    }
    /// 批次限制约 256 KiB；大正文已在归一化阶段卸载，不传整个历史。
    pub fn batch(&mut self, runtime_id: &str, ack: u64) -> Result<EventBatch> {
        self.acknowledge(ack)?;
        let mut events = vec![];
        let mut bytes = 0;
        let mut sequence = ack;
        for &(seq, offset, len) in &self.queue {
            if bytes > 256 * 1024 {
                break;
            }
            self.events.seek(SeekFrom::Start(offset))?;
            let mut data = vec![0; len];
            self.events.read_exact(&mut data)?;
            let value: Value = serde_json::from_slice(&data)
                .map_err(|_| AppError::new("SPOOL", "临时事件损坏"))?;
            // 仅相邻且同内容块的文本增量可合并；最终消息/生命周期顺序不改变。
            let merged = if value["type"] == "delta" {
                if let Some(last) = events.last_mut() {
                    let last: &mut Value = last;
                    if last["type"] == "delta"
                        && last["id"] == value["id"]
                        && last["field"] == value["field"]
                    {
                        let mut delta = last["delta"].as_str().unwrap_or("").to_string();
                        delta.push_str(value["delta"].as_str().unwrap_or(""));
                        last["delta"] = delta.into();
                        true
                    } else {
                        false
                    }
                } else {
                    false
                }
            } else {
                false
            };
            if !merged {
                events.push(value);
            }
            sequence = seq;
            bytes += len;
        }
        Ok(EventBatch {
            runtime_id: runtime_id.into(),
            sequence,
            events,
        })
    }
    /// 返回正文引用；正文与 spool 共享容量限制，避免无限增长。
    pub fn body(&mut self, text: &str) -> Result<String> {
        self.reserve(text.len())?;
        let id = format!("body-{}", self.refs.len() + 1);
        self.bodies.seek(SeekFrom::Start(self.body_end))?;
        self.bodies.write_all(text.as_bytes())?;
        self.refs.insert(id.clone(), (self.body_end, text.len()));
        self.body_end += text.len() as u64;
        Ok(id)
    }
    /// 返回 UTF-8 边界安全分块；字节游标只允许来自上次响应的 next 值。
    pub fn content(&mut self, id: &str, offset: usize) -> Result<Value> {
        let &(start, len) = self
            .refs
            .get(id)
            .ok_or_else(|| AppError::new("CONTENT", "正文已失效，请重新打开会话"))?;
        if offset > len {
            return Err(AppError::new("CONTENT", "正文偏移无效"));
        }
        let count = (len - offset).min(64 * 1024);
        self.bodies.seek(SeekFrom::Start(start + offset as u64))?;
        let mut data = vec![0; count];
        self.bodies.read_exact(&mut data)?;
        let end = match std::str::from_utf8(&data) {
            Ok(_) => data.len(),
            Err(error) => error.valid_up_to(),
        };
        if end == 0 && count != 0 {
            return Err(AppError::new("CONTENT", "正文游标不在 UTF-8 边界"));
        }
        Ok(
            serde_json::json!({"text":String::from_utf8_lossy(&data[..end]),"next":offset+end,"done":offset+end==len}),
        )
    }
}

/// 字节上限预览，末端始终处于字符边界，不拆断中文或 emoji。
pub fn preview(text: &str, max: usize) -> String {
    let mut end = text.len().min(max);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    /// 未 ack 的批次可重拉，ack 后释放；验证慢消费者顺序不丢失。
    #[test]
    fn durable_queue_and_utf8() {
        let mut store = Store::new().unwrap();
        store.push(json!({"type":"first"})).unwrap();
        store.push(json!({"type":"last"})).unwrap();
        let batch = store.batch("runtime", 0).unwrap();
        assert_eq!(batch.sequence, 2);
        assert_eq!(store.batch("runtime", 0).unwrap().events.len(), 2);
        assert!(store.batch("runtime", 2).unwrap().events.is_empty());
        let id = store.body(&"你".repeat(30000)).unwrap();
        let chunk = store.content(&id, 0).unwrap();
        assert_eq!(chunk["next"], 65535);
        assert_eq!(preview("你好", 4), "你");
    }
}
