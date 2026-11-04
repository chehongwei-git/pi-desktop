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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SidebarItem {
    pub kind: String,
    pub path: String,
    pub name: Option<String>,
    pub state: Option<String>,
}

/// 工作项目的新会话默认偏好；已有会话独立，不含凭据也不改写历史。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectModelPreference {
    pub project: String,
    pub provider: String,
    pub model: String,
    pub thinking_level: String,
}

/// 应用配置存启动方式、项目模型和界面偏好；Pi 凭据始终留在 Pi 目录。
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
    pub sidebar_items: Vec<SidebarItem>,
    pub project_models: Vec<ProjectModelPreference>,
    pub theme: String,
    pub zoom: u32,
    /// 全应用共享的执行名额，旧配置默认四个。
    pub max_concurrent_tasks: u32,
    /// 全局空闲进程额度；零表示不缓存后台进程。
    pub idle_process_limit: u32,
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
            sidebar_items: vec![],
            project_models: vec![],
            theme: "system".into(),
            zoom: 100,
            max_concurrent_tasks: 4,
            idle_process_limit: 5,
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

/// 图片通过私有正文引用按需读取，ID 用内容摘要关联排队占位。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageImage {
    pub id: String,
    pub mime_type: String,
    pub content_ref: String,
}

/// 同一回复的处理过程共用标识与时间，缺失旧计时记录时不估算。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInfo {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<i64>,
    /// 等待扩展回答期间冻结显示；旧记录默认没有暂停。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paused_at: Option<i64>,
    #[serde(default)]
    pub paused_ms: i64,
    pub state: String,
}

/// 正文由宿主私有临时文件托管；前端列表只接收有界预览。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    pub role: String,
    pub text: String,
    pub thinking: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_parts: Option<Vec<crate::text_presentation::TextPart>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub presentation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process: Option<ProcessInfo>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<MessageImage>,
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
        #[serde(default)]
        images: Vec<Value>,
        mode: Option<String>,
        #[serde(default, rename = "textParts")]
        text_parts: Option<Vec<crate::text_presentation::TextRange>>,
    },
    Stop,
    Reload,
    SetAutoCompaction {
        enabled: bool,
    },
    SetAutoRetry {
        enabled: bool,
    },
    SetSteeringMode {
        mode: String,
    },
    SetFollowUpMode {
        mode: String,
    },
    NewSession,
    NewProjectSession {
        project: String,
    },
    SwitchSession {
        path: String,
    },
    Rename {
        name: String,
    },
    Models,
    RefreshModels,
    ThinkingLevels,
    SetModel {
        provider: String,
        model: String,
    },
    SetThinking {
        level: String,
    },
    Commands,
    Compact {
        instructions: Option<String>,
    },
    Export {
        path: Option<String>,
    },
    Fork {
        #[serde(rename = "entryId")]
        entry_id: String,
    },
    Clone,
    SessionStats,
    LastAssistant,
    ForkMessages,
    SessionTree,
    NavigateTree {
        #[serde(rename = "entryId")]
        entry_id: String,
        summarize: bool,
    },
    State,
    History {
        before: Option<usize>,
    },
    ExtensionResponse {
        id: String,
        value: Value,
    },
}

/// 新会话初始提交的启动快照；排队期间不持有子进程。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewTaskRequest {
    pub project: String,
    pub submission_id: String,
    pub action: Action,
    pub model: Option<(String, String)>,
    pub thinking: Option<String>,
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
