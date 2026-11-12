//! PiRuntime Actor：唯一拥有 stdin/投影/临时存储。读任务独立，UI 慢时事件落盘。
use crate::{
    platform::{self, ProcessTree},
    rpc::{self, Projection},
    storage::Store,
    types::*,
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    process::Stdio,
    sync::{
        atomic::{AtomicU64, AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};
use tauri::ipc::Channel;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt, BufReader},
    process::Child,
    sync::{mpsc, oneshot, watch},
    time::{Instant, MissedTickBehavior},
};

#[path = "turn_changes.rs"]
mod turn_changes;

static RUNTIME_ID: AtomicU64 = AtomicU64::new(0);
/// 轻量句柄可克隆；有界邮箱避免快速连点导致无限分配。
#[derive(Clone)]
pub struct Handle {
    pub id: String,
    /// 物理进程身份保持稳定；id 是兼容现有 IPC 的会话租约身份。
    pub process_id: String,
    pub channel: Channel<Value>,
    pub lifecycle: watch::Receiver<Progress>,
    tx: mpsc::Sender<Request>,
    operations: Arc<AtomicUsize>,
}
/// 生命周期供宿主调度使用，不依赖前端是否正在阅读此会话。
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Lifecycle {
    Idle,
    Busy,
    Stopped,
}
/// settled 计数保证快速结束的任务也不会丢失完成通知。
#[derive(Clone, Copy)]
pub struct Progress {
    pub state: Lifecycle,
    pub settled: u64,
    pub failed: bool,
}
/// Actor 内部请求，外部 API 不可直接创建任意协议调用。
enum Request {
    Lease {
        id: String,
        request: Box<Request>,
    },
    Rebind {
        id: String,
        channel: Channel<Value>,
        reply: oneshot::Sender<Result<Value>>,
    },
    Rpc {
        command: Value,
        kind: Kind,
        reply: oneshot::Sender<Result<Value>>,
    },
    Events {
        ack: u64,
        reply: oneshot::Sender<Result<Value>>,
    },
    Content {
        id: String,
        offset: usize,
        reply: oneshot::Sender<Result<Value>>,
    },
    Shutdown {
        force: bool,
        reply: oneshot::Sender<Result<Value>>,
    },
}
#[derive(Clone, Copy)]
enum Kind {
    Query,
    Mutate,
    Restore,
    Reset,
    Refresh,
    LongRefresh,
    Extension,
    Bridge,
    BridgeRefresh,
}
struct Pending {
    reply: oneshot::Sender<Result<Value>>,
    deadline: Instant,
    kind: Kind,
    bridge_command: Option<String>,
    bridge_error: Option<String>,
    clears_text_queue: bool,
}

impl Request {
    fn reject(self) {
        let reply = match self {
            Self::Lease { request, .. } => {
                request.reject();
                return;
            }
            Self::Rebind { reply, .. }
            | Self::Rpc { reply, .. }
            | Self::Events { reply, .. }
            | Self::Content { reply, .. }
            | Self::Shutdown { reply, .. } => reply,
        };
        let _ = reply.send(Err(AppError::new("STALE_RUNTIME", "会话连接已更新")));
    }
}
/// 一个业务动作可能分多次 RPC；跨 await 的计数防止在查询与提交间被借走。
struct Operation(Arc<AtomicUsize>);
impl Drop for Operation {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}
impl Handle {
    async fn send(
        &self,
        request: Request,
    ) -> std::result::Result<(), mpsc::error::SendError<Request>> {
        self.tx
            .send(Request::Lease {
                id: self.id.clone(),
                request: Box::new(request),
            })
            .await
    }
    /// Actor 再次检查真实空闲状态；租约切换使排队中的旧请求也无法越界。
    pub async fn rebind(&self, id: String, channel: Channel<Value>) -> Result<Self> {
        let (reply, rx) = oneshot::channel();
        self.send(Request::Rebind {
            id: id.clone(),
            channel: channel.clone(),
            reply,
        })
        .await
        .map_err(|_| AppError::new("DISCONNECTED", "Pi 已断开"))?;
        rx.await
            .map_err(|_| AppError::new("DISCONNECTED", "Pi 已退出"))??;
        Ok(Self {
            id,
            channel,
            ..self.clone()
        })
    }
    pub fn notify_released(&self) {
        let _ = self
            .channel
            .send(json!({"type":"released", "runtimeId":self.id}));
    }
    /// 发送受控请求并等待关联响应。超时由 actor 负责，不做任何隐式重发。
    async fn rpc(&self, command: Value, kind: Kind) -> Result<Value> {
        let (reply, rx) = oneshot::channel();
        self.send(Request::Rpc {
            command,
            kind,
            reply,
        })
        .await
        .map_err(|_| AppError::new("DISCONNECTED", "Pi 已断开"))?;
        rx.await
            .map_err(|_| AppError::new("DISCONNECTED", "Pi 已退出"))?
    }
    /// 内部命令必须先确认注册，避免缺失时被当作提示词发给模型。
    async fn bridge(&self, name: &str, args: Value, kind: Kind) -> Result<Value> {
        let state = self.rpc(json!({"type":"get_state"}), Kind::Query).await?;
        // 仅模型与强度切换允许在运行中执行；重载和导航仍须空闲。
        if !matches!(name, "pi-desktop-thinking-v1" | "pi-desktop-model-v1")
            && (state["isStreaming"] == true || state["isCompacting"] == true)
        {
            return Err(AppError::new("BUSY", "请等待 Pi 空闲后执行命令"));
        }
        let data = self
            .rpc(json!({"type":"get_commands"}), Kind::Query)
            .await?;
        if !data["commands"].as_array().is_some_and(|commands| {
            commands
                .iter()
                .any(|c| c["name"] == name && c["source"] == "extension")
        }) {
            return Err(AppError::new(
                "BRIDGE_UNAVAILABLE",
                "Pi 桌面桥接未加载或版本不兼容",
            ));
        }
        let message = if args.is_null() {
            format!("/{name}")
        } else {
            format!("/{name} {args}")
        };
        self.rpc(json!({"type":"prompt","message":message}), kind)
            .await
    }
    /// 业务动作转换为白名单命令；停止必须先清队列，避免 abort 继续排队任务。
    pub async fn action(&self, action: Action) -> Result<Value> {
        self.operations.fetch_add(1, Ordering::SeqCst);
        let _operation = Operation(self.operations.clone());
        match action {
            Action::Prompt {
                message,
                images,
                mode,
                text_parts,
            } => {
                crate::images::validate(&images)?;
                if let Some(parts) = &text_parts {
                    crate::text_presentation::slices(&message, parts)?;
                    // 查询会话身份仅用于宿主展示绑定，展示数据不会进入 Pi 协议。
                    self.rpc(json!({"type":"get_state"}), Kind::Query).await?;
                }
                if message.trim().is_empty() && images.is_empty() {
                    return Err(AppError::new("EMPTY", "消息不能为空"));
                }
                // 仅带图时检查能力；Pi 仍负责最终解码及提供商格式转换。
                if !images.is_empty() {
                    if message.trim_start().starts_with('/') {
                        return Err(AppError::new("IMAGE", "图片不能与斜杠命令一起发送"));
                    }
                    let state = self.rpc(json!({"type":"get_state"}), Kind::Query).await?;
                    if state["model"]["input"]
                        .as_array()
                        .is_some_and(|input| !input.iter().any(|v| v == "image"))
                    {
                        return Err(AppError::new("IMAGE", "当前模型不支持图片输入，请切换模型"));
                    }
                }
                let mut cmd = json!({"type":"prompt","message":message});
                if let Some(parts) = text_parts {
                    cmd["_textParts"] = serde_json::to_value(parts)
                        .map_err(|_| AppError::new("TEXT_PARTS", "卡片编码失败"))?;
                }
                if !images.is_empty() {
                    cmd["images"] = images.into();
                }
                if let Some(mode) = mode {
                    if !["steer", "followUp"].contains(&mode.as_str()) {
                        return Err(AppError::new("MODE", "无效发送模式"));
                    }
                    cmd["streamingBehavior"] = mode.into();
                }
                self.rpc(cmd, Kind::Mutate).await
            }
            Action::SetAutoCompaction { enabled } => {
                self.rpc(
                    json!({"type":"set_auto_compaction","enabled":enabled}),
                    Kind::Mutate,
                )
                .await
            }
            Action::SetAutoRetry { enabled } => {
                self.rpc(
                    json!({"type":"set_auto_retry","enabled":enabled}),
                    Kind::Mutate,
                )
                .await
            }
            Action::SetSteeringMode { mode } => {
                if !["all", "one-at-a-time"].contains(&mode.as_str()) {
                    return Err(AppError::new("MODE", "无效队列模式"));
                }
                self.rpc(
                    json!({"type":"set_steering_mode","mode":mode}),
                    Kind::Mutate,
                )
                .await
            }
            Action::SetFollowUpMode { mode } => {
                if !["all", "one-at-a-time"].contains(&mode.as_str()) {
                    return Err(AppError::new("MODE", "无效队列模式"));
                }
                self.rpc(
                    json!({"type":"set_follow_up_mode","mode":mode}),
                    Kind::Mutate,
                )
                .await
            }
            Action::Reload => {
                // 两阶段调用使用重新加载后的扩展上下文；失败不重发、不退回重启。
                for name in ["pi-desktop-reload-v1", "pi-desktop-models-v1"] {
                    self.bridge(name, Value::Null, Kind::Bridge).await?;
                }
                Ok(json!({"reloaded":true}))
            }
            Action::Stop => {
                let cleared = self
                    .rpc(json!({"type":"clear_queue"}), Kind::Mutate)
                    .await?;
                self.rpc(json!({"type":"abort"}), Kind::Mutate).await?;
                Ok(cleared)
            }
            Action::NewSession => self.rpc(json!({"type":"new_session"}), Kind::Reset).await,
            Action::NewProjectSession { .. } => {
                Err(AppError::new("SESSION", "跨项目新建必须由宿主创建会话"))
            }
            Action::SwitchSession { path } => {
                self.rpc(
                    json!({"type":"switch_session","sessionPath":path}),
                    Kind::Reset,
                )
                .await
            }
            Action::Rename { name } => {
                self.rpc(json!({"type":"set_session_name","name":name}), Kind::Mutate)
                    .await
            }
            Action::RefreshModels => {
                self.bridge("pi-desktop-models-v1", Value::Null, Kind::Bridge)
                    .await
            }
            Action::Models => {
                self.rpc(json!({"type":"get_available_models"}), Kind::Query)
                    .await
            }
            Action::ThinkingLevels => {
                let state = self.rpc(json!({"type":"get_state"}), Kind::Query).await?;
                // 当前 reasoning=false 只表示关闭；按等级映射提供重新开启入口。
                let map = &state["model"]["thinkingLevelMap"];
                let levels: Vec<_> = crate::model_config::LEVELS
                    .into_iter()
                    .filter(|level| *level == "off" || map.get(*level) != Some(&Value::Null))
                    .collect();
                Ok(json!({"levels": levels}))
            }
            Action::SetModel {
                provider,
                model,
                thinking,
            } => {
                // 单条桥接命令应用模型与强度，避免续答读到中间配置。
                self.bridge(
                    "pi-desktop-model-v1",
                    json!({"provider":provider,"model":model,"thinking":thinking}),
                    Kind::Bridge,
                )
                .await
            }
            Action::SetThinking { level } => {
                self.bridge(
                    "pi-desktop-thinking-v1",
                    json!({"level":level}),
                    Kind::Bridge,
                )
                .await
            }
            Action::Compact { instructions } => {
                self.rpc(
                    json!({"type":"compact","customInstructions":instructions}),
                    Kind::LongRefresh,
                )
                .await
            }
            Action::Export { path } => {
                self.rpc(json!({"type":"export_html","outputPath":path}), Kind::Query)
                    .await
            }
            Action::Fork { entry_id } => {
                self.rpc(json!({"type":"fork","entryId":entry_id}), Kind::Refresh)
                    .await
            }
            Action::Clone => self.rpc(json!({"type":"clone"}), Kind::Refresh).await,
            Action::SessionStats => {
                self.rpc(json!({"type":"get_session_stats"}), Kind::Query)
                    .await
            }
            Action::LastAssistant => {
                self.rpc(json!({"type":"get_last_assistant_text"}), Kind::Query)
                    .await
            }
            Action::ForkMessages => {
                self.rpc(json!({"type":"get_fork_messages"}), Kind::Query)
                    .await
            }
            // get_tree 为每条消息再嵌套 children，长会话会超过 JSON 解析深度。
            // 使用同一 Pi 的平铺记录，宿主只向界面传递节点摘要。
            Action::SessionTree => {
                let data = self.rpc(json!({"type":"get_entries"}), Kind::Query).await?;
                rpc::tree_entries(&data)
            }
            Action::NavigateTree {
                entry_id,
                summarize,
            } => {
                self.bridge(
                    "pi-desktop-navigate-v1",
                    json!({"entryId":entry_id,"summarize":summarize}),
                    Kind::BridgeRefresh,
                )
                .await
            }
            Action::Changes => {
                self.rpc(json!({"type":"desktop_changes"}), Kind::Query)
                    .await
            }
            Action::Commands => self.rpc(json!({"type":"get_commands"}), Kind::Query).await,
            Action::State => self.rpc(json!({"type":"get_state"}), Kind::Query).await,
            Action::History { before } => {
                self.rpc(
                    json!({"type":"get_entries","_before":before}),
                    Kind::Restore,
                )
                .await
            }
            Action::ExtensionResponse { id, value } => {
                let mut response = json!({"type":"extension_ui_response","id":id});
                for field in ["value", "confirmed", "cancelled"] {
                    if let Some(value) = value.get(field) {
                        response[field] = value.clone();
                    }
                }
                self.rpc(response, Kind::Extension).await
            }
        }
    }
    /// 以确认游标获取有界事件批次；由前端成功归并后提交 ack。
    pub async fn events(&self, ack: u64) -> Result<Value> {
        let (reply, rx) = oneshot::channel();
        self.send(Request::Events { ack, reply })
            .await
            .map_err(|_| AppError::new("DISCONNECTED", "Pi 已退出"))?;
        rx.await
            .map_err(|_| AppError::new("DISCONNECTED", "Pi 已退出"))?
    }
    /// 正文只按宿主分配的 ID 读取，不能变成通用文件读取接口。
    pub async fn content(&self, id: String, offset: usize) -> Result<Value> {
        let (reply, rx) = oneshot::channel();
        self.send(Request::Content { id, offset, reply })
            .await
            .map_err(|_| AppError::new("DISCONNECTED", "Pi 已退出"))?;
        rx.await
            .map_err(|_| AppError::new("DISCONNECTED", "Pi 已退出"))?
    }
    /// 正常关闭 stdin 并等待，超时回收树；调用方须等待后再创建另一个实例。
    #[cfg(test)]
    pub async fn shutdown(&self) -> Result<()> {
        self.close(false).await
    }
    /// 用户显式强制关闭时跳过 3 秒宽限，Job/进程组仍只影响自有子树。
    pub async fn close(&self, force: bool) -> Result<()> {
        let (reply, rx) = oneshot::channel();
        let mut lifecycle = self.lifecycle.clone();
        if lifecycle.borrow().state == Lifecycle::Stopped {
            return Ok(());
        }
        if self.send(Request::Shutdown { force, reply }).await.is_ok() {
            rx.await
                .map_err(|_| AppError::new("DISCONNECTED", "Pi 已退出"))??;
        }
        // Shutdown 回执先于 actor 最终清理；等到进程回收后才允许调度器释放名额。
        while lifecycle.borrow_and_update().state != Lifecycle::Stopped {
            if lifecycle.changed().await.is_err() {
                break;
            }
        }
        Ok(())
    }
}

/// 验证 cwd 后创建一个 Pi；actor 就绪前订阅已存在，避免初始化事件丢失。
#[cfg(test)]
pub async fn start(
    settings: &Settings,
    project: String,
    channel: Channel<Value>,
) -> Result<Handle> {
    start_reserved(settings, project, channel, None).await
}
/// 排队任务预先拥有稳定标识，真正获得名额后才创建对应子进程。
pub async fn start_reserved(
    settings: &Settings,
    project: String,
    channel: Channel<Value>,
    reserved_id: Option<String>,
) -> Result<Handle> {
    if !std::path::Path::new(&project).is_dir() {
        return Err(AppError::new("PROJECT", "项目目录不存在"));
    }
    let spec = platform::discover(settings)?;
    let mut command = platform::command(&spec, settings)?;
    command
        .args(["--mode", "rpc"])
        .current_dir(&project)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if !settings.session_dir.is_empty() {
        command.args(["--session-dir", &settings.session_dir]);
    }
    // 源码嵌入 Rust 产物，释放到私有临时目录；无需额外资源定位或 JS 运行时。
    let bridge_dir = tempfile::Builder::new()
        .prefix("pi-desktop-bridge-")
        .tempdir()?;
    let bridge_path = bridge_dir.path().join("desktop.mjs");
    std::fs::write(&bridge_path, include_str!("../bridge/desktop.mjs"))?;
    command.arg("--extension").arg(&bridge_path);
    let mut child = command.spawn()?;
    let tree = match ProcessTree::attach(&child) {
        Ok(t) => t,
        Err(e) => {
            let _ = child.kill().await;
            return Err(e);
        }
    };
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| AppError::new("PIPE", "stdin 创建失败"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::new("PIPE", "stdout 创建失败"))?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| AppError::new("PIPE", "stderr 创建失败"))?;
    let store = Store::new()?;
    let (tx, rx) = mpsc::channel(64);
    let (output_tx, output_rx) = mpsc::channel(2);
    let reader = tokio::spawn(async move {
        let mut reader = BufReader::new(stdout);
        loop {
            let event = rpc::record(&mut reader).await;
            let finished = !matches!(event, Ok(Some(_)));
            if output_tx.send(event).await.is_err() || finished {
                break;
            }
        }
    });
    // stderr 持续排空但不记原文，扩展可能把密钥/提示词写入诊断。
    let diagnostics = tokio::spawn(async move {
        let mut buf = [0u8; 8192];
        loop {
            match stderr.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
        }
    });
    let id = reserved_id
        .unwrap_or_else(|| format!("runtime-{}", RUNTIME_ID.fetch_add(1, Ordering::Relaxed) + 1));
    tracing::info!(runtime_id=%id, "runtime started");
    let (lifecycle_tx, lifecycle) = watch::channel(Progress {
        state: Lifecycle::Idle,
        settled: 0,
        failed: false,
    });
    let operations = Arc::new(AtomicUsize::new(0));
    let handle = Handle {
        id: id.clone(),
        process_id: id.clone(),
        channel: channel.clone(),
        operations: operations.clone(),
        tx,
        lifecycle,
    };
    let projection =
        Projection::with_timing_dir(crate::history::root(settings).join(".desktop-process"));
    let changes = turn_changes::Recorder::new(
        project.into(),
        crate::history::root(settings).join(".desktop-changes"),
    );
    tokio::spawn(async move {
        actor(
            id,
            child,
            stdin,
            tree,
            store,
            rx,
            output_rx,
            channel,
            projection,
            lifecycle_tx,
            operations,
            changes,
        )
        .await;
        reader.abort();
        diagnostics.abort();
        drop(bridge_dir);
    });
    Ok(handle)
}

/// 所有可变运行状态集中于单 actor；UI 通知只唤醒拉取，不携带海量正文。
#[allow(clippy::too_many_arguments)]
async fn actor(
    mut id: String,
    mut child: Child,
    mut stdin: tokio::process::ChildStdin,
    tree: ProcessTree,
    mut store: Store,
    mut requests: mpsc::Receiver<Request>,
    mut output: mpsc::Receiver<Result<Option<Value>>>,
    mut channel: Channel<Value>,
    mut projection: Projection,
    lifecycle: watch::Sender<Progress>,
    operations: Arc<AtomicUsize>,
    mut changes: turn_changes::Recorder,
) {
    let mut pending: HashMap<String, Pending> = HashMap::new();
    let mut serial = 0u64;
    let mut restored = false;
    let mut change_refs: HashMap<String, String> = HashMap::new();
    let mut stopped = false;
    let mut previous_store: Option<(String, Store)> = None;
    // RPC 超时后的副作用未知，禁止把该进程借给其他会话。
    let mut uncertain = false;
    let mut tick = tokio::time::interval(Duration::from_millis(33));
    tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut failure: Option<AppError> = None;
    loop {
        tokio::select! {
            request = requests.recv() => {
                let request = match request {
                    Some(Request::Lease { id: lease, request }) if lease == id => Some(*request),
                    Some(request) => { request.reject(); continue; }
                    None => None,
                };
                match request {
                Some(Request::Rebind { id: next, channel: target, reply }) => {
                    if uncertain || operations.load(Ordering::SeqCst) > 0 || !pending.is_empty() || lifecycle.borrow().state != Lifecycle::Idle || projection.waiting_for_extension() {
                        let _ = reply.send(Err(AppError::new("BUSY", "Pi 尚有在途操作，暂不能复用")));
                    } else {
                        // 切换期间旧事件/正文不可进入新页面；取消时恢复原 spool 和 ACK 空间。
                        if previous_store.as_ref().is_some_and(|(lease,_)| lease == &next) {
                            store = previous_store.take().unwrap().1;
                        } else {
                            match Store::new() {
                                Ok(empty) => previous_store = Some((id.clone(), std::mem::replace(&mut store, empty))),
                                Err(error) => { let _ = reply.send(Err(error)); continue; }
                            }
                        }
                        change_refs.clear();
                        id = next; channel = target;
                        let _ = reply.send(Ok(Value::Null));
                    }
                }
                Some(Request::Lease { .. }) => unreachable!(),
                Some(Request::Rpc { mut command, kind, reply }) => {
                    // 桥接期间只接受查询与扩展交互响应，禁止命令错误关联和会话并发修改。
                    if !matches!(kind, Kind::Query | Kind::Restore | Kind::Extension) && pending.values().any(|p| p.bridge_command.is_some()) {
                        let _ = reply.send(Err(AppError::new("BUSY", "Pi 桥接操作仍在执行，请稍后再试"))); continue;
                    }
                    if matches!(kind, Kind::Restore) && restored {
                        let before = command["_before"].as_u64().map(|v| v as usize); let _ = reply.send(Ok(projection.page(before))); continue;
                    }
                    if command["type"] == "desktop_changes" {
                        let (recorder, records) = tokio::task::spawn_blocking(move || { let records = changes.list(); (changes, records) }).await.expect("changes recorder panicked");
                        changes = recorder;
                        let result = (|| -> Result<Value> {
                            let mut turns = serde_json::to_value(records).map_err(|_| AppError::new("CHANGES", "读取轮次失败"))?;
                            if let Some(turns) = turns.as_array_mut() {
                                for turn in turns {
                                    let turn_id = turn["id"].as_str().unwrap_or("").to_string();
                                    if let Some(files) = turn["files"].as_array_mut() {
                                        for file in files {
                                            let diff = file["diff"].as_str().unwrap_or("");
                                            let key = format!("{}:{}", turn_id, file["path"]);
                                            let reference = if let Some(reference) = change_refs.get(&key) { reference.clone() } else {
                                                let reference = store.body(diff)?;
                                                change_refs.insert(key, reference.clone()); reference
                                            };
                                            file.as_object_mut().unwrap().remove("diff");
                                            file["contentRef"] = reference.into();
                                        }
                                    }
                                }
                            }
                            Ok(turns)
                        })();
                        let _ = reply.send(result); continue;
                    }
                    if command["type"] == "abort" { stopped = true; }
                    // 提交前完成基线采集，避免 agent_start 通知到达时文件已经被工具改写。
                    if command["type"] == "prompt" && !command["message"].as_str().unwrap_or("").starts_with('/') {
                        let title = command["message"].as_str().unwrap_or("").to_string();
                        changes = tokio::task::spawn_blocking(move || { changes.begin(&title); changes }).await.expect("changes recorder panicked");
                    }
                    serial += 1; let request_id = format!("req-{serial}");
                    // 扩展交互以 Pi 分配的 ID 关联等待者，且不产生普通 RPC 响应。
                    if !matches!(kind, Kind::Extension) { command["id"] = request_id.clone().into(); }
                    let parts = command.as_object_mut().and_then(|object| object.remove("_textParts"));
                    if let Some(parts) = parts {
                        let prepared = serde_json::from_value(parts).map_err(|_| AppError::new("TEXT_PARTS", "卡片数据无效")).and_then(|parts| projection.text_presentations.prepare(request_id.clone(), &command, parts));
                        if let Err(error) = prepared { let _ = reply.send(Err(error)); continue; }
                    }
                    if let Some(object) = command.as_object_mut() { object.remove("_before"); }
                    let mut bytes = match serde_json::to_vec(&command) { Ok(b) => b, Err(_) => { let _ = reply.send(Err(AppError::new("SERIALIZE", "请求编码失败"))); continue; } }; bytes.push(b'\n');
                    // 写管道也设上限，防止子进程不读 stdin 时 actor 永久卡死。
                    match tokio::time::timeout(Duration::from_secs(5), stdin.write_all(&bytes)).await {
                        Ok(Ok(())) => {}, _ => { let error = AppError::new("PIPE", "Pi 输入管道阻塞或断开，请重新连接"); let _ = reply.send(Err(error.clone())); failure = Some(error); break; }
                    }
                    if matches!(kind, Kind::Extension) {
                        // 扩展响应没有 RPC 回执，以管道写入成功作为恢复计时的边界。
                        let result = projection.extension_responded(command["id"].as_str().unwrap_or(""), &mut store);
                        let _ = reply.send(result.map(|()| Value::Null));
                    }
                    else {
                        let seconds = if matches!(kind, Kind::Bridge | Kind::BridgeRefresh) { 120 } else if matches!(kind, Kind::LongRefresh) { 600 } else if matches!(kind, Kind::Reset | Kind::Restore | Kind::Refresh) { 30 } else if matches!(kind, Kind::Mutate) { 15 } else { 10 };
                        let bridge_command = if matches!(kind, Kind::Bridge | Kind::BridgeRefresh) { command["message"].as_str().and_then(|message| message.split_whitespace().next()).map(|message| format!("command:{}", message.trim_start_matches('/'))) } else { None };
                        pending.insert(request_id, Pending { reply, kind, bridge_command, bridge_error: None, clears_text_queue: command["type"] == "clear_queue", deadline: Instant::now()+Duration::from_secs(seconds) });
                    }
                }
                Some(Request::Events { ack, reply }) => { let result = store.batch(&id, ack).and_then(|batch| serde_json::to_value(batch).map_err(|_| AppError::new("SERIALIZE", "批次编码失败"))); let _ = reply.send(result); }
                Some(Request::Content { id, offset, reply }) => { let _ = reply.send(store.content(&id, offset)); }
                Some(Request::Shutdown { force, reply }) => {
                    // ChildStdin::shutdown 不保证关闭 OS 管道；显式 drop 才能让 Pi 收到 EOF。
                    drop(stdin);
                    if force || tokio::time::timeout(Duration::from_secs(3), child.wait()).await.is_err() { tree.terminate(); let _ = child.kill().await; }
                    let _ = reply.send(Ok(Value::Null)); break;
                }
                None => break,
                }
            },
            event = output.recv() => match event {
                Some(Ok(Some(event))) if event["type"] == "response" => {
                    if let Some(request_id) = event["id"].as_str() {
                        if let Some(request) = pending.remove(request_id) {
                            if event["success"] != true { projection.text_presentations.reject(request_id); }
                            else if request.clears_text_queue { projection.text_presentations.clear(); }
                            changes.context(&event["data"]);
                            if event["success"] != true && matches!(request.kind, Kind::Mutate) && lifecycle.borrow().state == Lifecycle::Idle { changes.cancel(); }
                            if let Some(path) = event["data"]["sessionFile"].as_str() { projection.text_presentations.context(path); }
                            let result = if event["success"] != true { Err(AppError::new("PI_COMMAND", event["error"].as_str().unwrap_or("Pi 拒绝了请求"))) }
                            else if let Some(error) = request.bridge_error { Err(AppError::new("BRIDGE_FAILED", error)) }
                            else if matches!(request.kind, Kind::Bridge | Kind::BridgeRefresh) && event["data"]["disposition"] != "handled" { Err(AppError::new("BRIDGE_PROTOCOL", "桥接命令未被扩展处理，请检查 Pi 版本")) }
                            else if matches!(request.kind, Kind::Restore) {
                                projection.restore(&event["data"], &mut store).map(|()| { restored=true; projection.page(None) })
                            } else { if matches!(request.kind, Kind::Reset | Kind::Refresh | Kind::LongRefresh | Kind::BridgeRefresh) && event["data"]["cancelled"] != true { if matches!(request.kind, Kind::Reset) { projection.reset(); projection.text_presentations.clear(); previous_store = None; let _ = store.push(json!({"type":"reset"})); } restored=false; } Ok(event["data"].clone()) };
                            let _ = request.reply.send(result);
                        }
                    }
                }
                Some(Ok(Some(event))) if event["type"] == "extension_error" && pending.values().any(|p| p.bridge_command.as_deref() == event["extensionPath"].as_str()) => {
                    for request in pending.values_mut().filter(|p| p.bridge_command.as_deref() == event["extensionPath"].as_str()) {
                        request.bridge_error = Some(event["error"].as_str().unwrap_or("桌面桥接执行失败").to_string());
                    }
                }
                Some(Ok(Some(event))) => {
                    let mut previous = *lifecycle.borrow();
                    if event["type"] == "agent_start" { previous.failed = false; stopped = false; }
                    if event["type"] == "message_end" && event["message"]["stopReason"] == "error" {
                        previous.failed = true; lifecycle.send_replace(previous);
                    }
                    let next = match event["type"].as_str() {
                        Some("agent_start" | "auto_retry_start" | "compaction_start") => Some(Lifecycle::Busy),
                        Some("agent_settled") => Some(Lifecycle::Idle),
                        _ => None,
                    };
                    if event["type"] == "agent_start" {
                        changes = tokio::task::spawn_blocking(move || { changes.begin("后续任务"); changes }).await.expect("changes recorder panicked");
                    }
                    if event["type"] == "agent_settled" {
                        // 错误后的退避也允许停止；取消应覆盖此前失败尝试的临时标记。
                        if stopped { previous.failed = false; }
                        let state = if stopped { "stopped" } else if previous.failed { "error" } else { "done" };
                        let (recorder, result) = tokio::task::spawn_blocking(move || {
                            let result = changes.finish(state);
                            (changes, result)
                        }).await.expect("changes recorder panicked");
                        changes = recorder;
                        if result.is_err() {
                            let _ = store.push(json!({"type":"notice","message":"本轮代码变更保存失败，请从处理过程查看单次修改。"}));
                        }
                    }
                    if let Err(error) = projection.event(event, &mut store) { failure=Some(error); break; }
                    if let Some(next) = next {
                        lifecycle.send_replace(Progress { state: next, settled: previous.settled + u64::from(next == Lifecycle::Idle), failed:previous.failed });
                    }
                },
                Some(Err(error)) => { failure=Some(error); break; },
                _ => { failure=Some(AppError::new("PROCESS_EXIT", "Pi 进程已退出，当前内容与草稿已保留")); break; }
            },
            _ = tick.tick() => {
                let expired: Vec<_> = pending.iter().filter(|(_, p)| p.deadline<=Instant::now()).map(|(id, _)| id.clone()).collect();
                for request_id in expired { projection.text_presentations.reject(&request_id); uncertain = true; if let Some(p) = pending.remove(&request_id) { let _ = p.reply.send(Err(AppError::new("TIMEOUT", "请求超时，可能已执行；请检查状态，不要自动重发"))); } }
                if store.has_pending() { let _ = channel.send(json!({"type":"available","runtimeId":id})); }
            }
        }
    }
    let _ = tokio::task::spawn_blocking(move || changes.finish("stopped")).await;
    for (_, request) in pending {
        let _ = request.reply.send(Err(failure
            .clone()
            .unwrap_or_else(|| AppError::new("DISCONNECTED", "连接已关闭"))));
    }
    if let Some(error) = failure {
        tracing::warn!(code=%error.code, runtime_id=%id, "runtime stopped");
        let _ = channel.send(json!({"type":"failed","runtimeId":id,"error":error}));
    }
    let _ = child.kill().await;
    drop(tree);
    let previous = *lifecycle.borrow();
    lifecycle.send_replace(Progress {
        state: Lifecycle::Stopped,
        ..previous
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    /// 失败尝试尚在退避时仍为 Busy；停止后的最终结果必须是取消而非失败。
    #[tokio::test]
    async fn stop_during_sse_retry_clears_transient_failure() {
        let project = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap();
        let settings = Settings {
            pi_path: project
                .join("tests/fixtures/mock-pi.mjs")
                .to_string_lossy()
                .into(),
            ..Settings::default()
        };
        let handle = start(
            &settings,
            project.to_string_lossy().into(),
            Channel::new(|_| Ok(())),
        )
        .await
        .unwrap();
        handle
            .action(Action::Prompt {
                message: "hold:sse-retry".into(),
                images: vec![],
                mode: None,
                text_parts: None,
            })
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let batch = handle.events(0).await.unwrap();
                if batch["events"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|event| event["state"] == "retrying")
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert!(matches!(handle.lifecycle.borrow().state, Lifecycle::Busy));
        assert!(handle.lifecycle.borrow().failed);
        handle.action(Action::Stop).await.unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if handle.lifecycle.borrow().settled > 0 {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert!(matches!(handle.lifecycle.borrow().state, Lifecycle::Idle));
        assert!(!handle.lifecycle.borrow().failed);
        handle.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn extension_response_preserves_pi_id_and_releases_abort() {
        let project = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap();
        let settings = Settings {
            pi_path: project
                .join("tests/fixtures/mock-pi.mjs")
                .to_string_lossy()
                .into(),
            ..Settings::default()
        };
        let handle = start(
            &settings,
            project.to_string_lossy().into(),
            Channel::new(|_| Ok(())),
        )
        .await
        .unwrap();
        handle
            .action(Action::Rename {
                name: "plan-dialog".into(),
            })
            .await
            .unwrap();
        let stopping = {
            let handle = handle.clone();
            tokio::spawn(async move { handle.action(Action::Stop).await })
        };
        tokio::time::timeout(Duration::from_secs(3), async {
            let mut ack = 0;
            loop {
                let batch = handle.events(ack).await.unwrap();
                ack = batch["sequence"].as_u64().unwrap();
                if batch["events"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|event| event["request"]["id"] == "pi-plan-choice")
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            handle
                .action(Action::ExtensionResponse {
                    id: "pi-plan-choice".into(),
                    value: json!({"cancelled":true}),
                })
                .await
                .unwrap();
            stopping.await.unwrap().unwrap();
        })
        .await
        .unwrap();
        assert_eq!(
            handle.action(Action::State).await.unwrap()["isStreaming"],
            false
        );
        handle.shutdown().await.unwrap();
    }
    /// 真实 Actor 在流式任务中只放行模型配置，不停止任务，也不放开重载。
    #[tokio::test]
    async fn model_selection_during_streaming_preserves_task() {
        let project = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap();
        let settings = Settings {
            pi_path: project
                .join("tests/fixtures/mock-pi.mjs")
                .to_string_lossy()
                .into(),
            ..Settings::default()
        };
        let handle = start(
            &settings,
            project.to_string_lossy().into(),
            Channel::new(|_| Ok(())),
        )
        .await
        .unwrap();
        handle
            .action(Action::Prompt {
                message: "hold:selection".into(),
                images: vec![],
                mode: None,
                text_parts: None,
            })
            .await
            .unwrap();
        handle
            .action(Action::SetModel {
                provider: "mock".into(),
                model: "other".into(),
                thinking: Some("high".into()),
            })
            .await
            .unwrap();
        let state = handle.action(Action::State).await.unwrap();
        assert_eq!(state["model"]["id"], "other");
        assert_eq!(state["thinkingLevel"], "high");
        assert_eq!(state["isStreaming"], true);
        handle
            .action(Action::SetThinking {
                level: "low".into(),
            })
            .await
            .unwrap();
        assert_eq!(
            handle.action(Action::State).await.unwrap()["thinkingLevel"],
            "low"
        );
        assert_eq!(
            handle.action(Action::Reload).await.unwrap_err().code,
            "BUSY"
        );
        handle.action(Action::Stop).await.unwrap();
        handle.shutdown().await.unwrap();
    }

    /// 真实 Node 子进程经过平台启动器与 Job guard，重复 20 轮验证资源回收和协议投影。
    #[tokio::test]
    async fn mock_rpc_twenty_lifecycles() {
        let project = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap();
        let settings = Settings {
            pi_path: project
                .join("tests/fixtures/mock-pi.mjs")
                .to_string_lossy()
                .into(),
            ..Settings::default()
        };
        for _ in 0..20 {
            let handle = start(
                &settings,
                project.to_string_lossy().into(),
                Channel::new(|_| Ok(())),
            )
            .await
            .unwrap();
            let state = handle.action(Action::State).await.unwrap();
            assert_eq!(state["sessionFile"], "mock.jsonl");
            assert_eq!(
                handle.action(Action::Reload).await.unwrap()["reloaded"],
                true
            );
            handle
                .action(Action::Rename {
                    name: "bridge-error".into(),
                })
                .await
                .unwrap();
            assert_eq!(
                handle.action(Action::Reload).await.unwrap_err().code,
                "BRIDGE_FAILED"
            );
            handle
                .action(Action::Rename {
                    name: "mock".into(),
                })
                .await
                .unwrap();
            let history = handle
                .action(Action::History { before: None })
                .await
                .unwrap();
            assert_eq!(history["messages"].as_array().unwrap().len(), 2);
            let compacted = handle
                .action(Action::Compact {
                    instructions: Some("keep code".into()),
                })
                .await
                .unwrap();
            assert_eq!(compacted["summary"], "compacted");
            let refreshed = handle
                .action(Action::History { before: None })
                .await
                .unwrap();
            assert!(refreshed["messages"]
                .as_array()
                .unwrap()
                .iter()
                .any(|message| message["text"] == "keep code"));
            assert_eq!(
                handle
                    .action(Action::Export {
                        path: Some("session.html".into())
                    })
                    .await
                    .unwrap()["path"],
                "session.html"
            );
            assert_eq!(
                handle.action(Action::SessionStats).await.unwrap()["totalMessages"],
                3
            );
            assert_eq!(
                handle.action(Action::LastAssistant).await.unwrap()["text"],
                "restored"
            );
            assert_eq!(
                handle.action(Action::ForkMessages).await.unwrap()["messages"][0]["entryId"],
                "u1"
            );
            assert_eq!(
                handle.action(Action::SessionTree).await.unwrap()["leafId"],
                "compact-result"
            );
            assert_eq!(
                handle
                    .action(Action::Fork {
                        entry_id: "cancel".into()
                    })
                    .await
                    .unwrap()["cancelled"],
                true
            );
            assert_eq!(
                handle.action(Action::Clone).await.unwrap()["cancelled"],
                false
            );
            let cloned_history = handle
                .action(Action::History { before: None })
                .await
                .unwrap();
            assert_eq!(cloned_history["messages"].as_array().unwrap().len(), 3);
            let cancelled = handle
                .action(Action::SwitchSession {
                    path: "cancel".into(),
                })
                .await
                .unwrap();
            assert_eq!(cancelled["cancelled"], true);
            handle
                .action(Action::Prompt {
                    images: vec![
                        json!({"type":"image","mimeType":"image/png","data":"iVBORw0KGgo="}),
                    ],
                    message: "hello".into(),
                    mode: None,
                    text_parts: Some(vec![crate::text_presentation::TextRange {
                        kind: "paste".into(),
                        id: "pasted".into(),
                        start: 0,
                        end: 5,
                        files: None,
                    }]),
                })
                .await
                .unwrap();
            let mut ack = 0;
            let mut idle = false;
            tokio::time::timeout(Duration::from_secs(5), async {
                while !idle {
                    let batch = handle.events(ack).await.unwrap();
                    for event in batch["events"].as_array().unwrap() {
                        if event["type"] == "run" && event["state"] == "idle" {
                            idle = true;
                        }
                    }
                    ack = batch["sequence"].as_u64().unwrap();
                    if !idle {
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                }
            })
            .await
            .unwrap();
            let page = handle
                .action(Action::History { before: None })
                .await
                .unwrap();
            let messages = page["messages"].as_array().unwrap();
            assert!(messages
                .iter()
                .any(|m| m["text"] == "你好\u{2028}RPC final"));
            assert_eq!(messages.iter().filter(|m| m["id"] == "tool-t1").count(), 1);
            let user = messages
                .iter()
                .find(|m| m["role"] == "user" && m["text"] == "hello")
                .unwrap();
            assert_eq!(user["textParts"][0]["kind"], "paste");
            assert_eq!(
                handle
                    .content(
                        user["textParts"][0]["contentRef"].as_str().unwrap().into(),
                        0
                    )
                    .await
                    .unwrap()["text"],
                "hello"
            );
            let image = &messages
                .iter()
                .find(|m| m["role"] == "user" && m["text"] == "hello")
                .unwrap()["images"][0];
            assert_eq!(
                handle
                    .content(image["contentRef"].as_str().unwrap().into(), 0)
                    .await
                    .unwrap()["text"],
                "iVBORw0KGgo="
            );
            let queued = handle.action(Action::Stop).await.unwrap();
            assert_eq!(queued["steering"][0], "queued draft");
            handle.shutdown().await.unwrap();
            assert!(handle.action(Action::State).await.is_err());
        }
    }
}
