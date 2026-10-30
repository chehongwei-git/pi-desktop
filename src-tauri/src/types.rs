//! 跨 IPC 的业务契约；字段采用 camelCase，与前端 types.ts 的契约夹具同步维护。
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::atomic::{AtomicU64, Ordering};
static ERROR_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// 结构化错误不携带提示词、工具正文或环境变量；code 可供界面稳定分支。
#[derive(Debug, Clone, Serialize, thiserror::Error)]
#[serde(rename_all = "camelCase")]
#[error("{message}")]
pub struct AppError {
    pub code: String,
    pub message: String,
    /// 仅含进程号与计数，可在不记录错误正文的日志中关联故障。
    pub diagnostic_id: String,
}
impl AppError {
    /// 将边界错误映射为可读消息。调用方负责不把敏感正文拼入 message。
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        let diagnostic_id = format!(
            "{}-{}",
            std::process::id(),
            ERROR_SEQUENCE.fetch_add(1, Ordering::Relaxed) + 1
        );
        tracing::warn!(code, diagnostic_id, "application boundary error");
        Self {
            code: code.into(),
            message: message.into(),
            diagnostic_id,
        }
    }
}
impl From<std::io::Error> for AppError {
    /// IO 错误只带系统描述，不附加正在处理的内容。
    fn from(error: std::io::Error) -> Self {
        Self::new("IO", error.to_string())
    }
}
pub type Result<T> = std::result::Result<T, AppError>;

/// 应用配置仅存启动方式和界面偏好；Pi 凭据始终留在 Pi 目录。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub schema_version: u32,
    pub pi_path: String,
    pub runtime_path: String,
    pub extra_path: Vec<String>,
    pub session_dir: String,
    pub recent_projects: Vec<String>,
    pub project_order: Vec<String>,
    pub pinned_sessions: Vec<String>,
    pub theme: String,
    pub zoom: u32,
}
impl Default for Settings {
    /// 未配置时自动发现 Pi，采用系统主题，不创建默认工作项目。
    fn default() -> Self {
        Self {
            schema_version: 1,
            pi_path: String::new(),
            runtime_path: String::new(),
            extra_path: vec![],
            session_dir: String::new(),
            recent_projects: vec![],
            project_order: vec![],
            pinned_sessions: vec![],
            theme: "system".into(),
            zoom: 100,
        }
    }
}

/// 启动规格完全由宿主解析，不通过 shell 拼接用户输入。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchSpec {
    pub executable: String,
    pub args: Vec<String>,
}

/// 摘要不含完整正文；历史搜索只遍历这些元数据。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub path: String,
    pub id: String,
    pub cwd: String,
    pub name: String,
    pub preview: String,
    pub timestamp: String,
    pub modified: u64,
    pub last_prompt_at: String,
    pub warning: Option<String>,
}

/// 正文由宿主私有临时文件托管；前端列表只接收有界预览。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    pub role: String,
    pub text: String,
    pub thinking: String,
    pub content_ref: Option<String>,
    #[serde(default)]
    pub truncated: bool,
    pub status: String,
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<crate::tool::ToolPresentation>,
}

/// 唯一可调用的 Pi 业务集合。不存在透传任意 RPC 的后门。
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Action {
    Prompt {
        message: String,
        mode: Option<String>,
    },
    Stop,
    NewSession,
    SwitchSession {
        path: String,
    },
    Rename {
        name: String,
    },
    Models,
    ThinkingLevels,
    SetModel {
        provider: String,
        model: String,
    },
    SetThinking {
        level: String,
    },
    Commands,
    State,
    History {
        before: Option<usize>,
    },
    ExtensionResponse {
        id: String,
        value: Value,
    },
}

/// 每个批次单调递增；runtimeId 隔离重启前的迟到数据。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventBatch {
    pub runtime_id: String,
    pub sequence: u64,
    pub events: Vec<Value>,
}

#[cfg(test)]
mod tests {
    use super::*;
    /// 同一个 JSON 样例被前端测试导入，确保 camelCase、null 与序号可双向序列化。
    #[test]
    fn event_batch_contract() {
        let fixture: Value =
            serde_json::from_str(include_str!("../../tests/fixtures/event-batch.json")).unwrap();
        let batch: EventBatch = serde_json::from_value(fixture.clone()).unwrap();
        let message: Message = serde_json::from_value(batch.events[0]["message"].clone()).unwrap();
        assert_eq!(message.content_ref.as_deref(), Some("body-1"));
        assert_eq!(serde_json::to_value(batch).unwrap(), fixture);
    }
}
