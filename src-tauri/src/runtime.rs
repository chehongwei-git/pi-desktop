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
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};
use tauri::ipc::Channel;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt, BufReader},
    process::Child,
    sync::{mpsc, oneshot, watch},
    time::{Instant, MissedTickBehavior},
};

static RUNTIME_ID: AtomicU64 = AtomicU64::new(0);
/// 轻量句柄可克隆；有界邮箱避免快速连点导致无限分配。
#[derive(Clone)]
pub struct Handle {
    pub id: String,
    pub lifecycle: watch::Receiver<Progress>,
    tx: mpsc::Sender<Request>,
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
}

impl Handle {
    /// 发送受控请求并等待关联响应。超时由 actor 负责，不做任何隐式重发。
    async fn rpc(&self, command: Value, kind: Kind) -> Result<Value> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Request::Rpc {
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
        if state["isStreaming"] == true || state["isCompacting"] == true {
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
        match action {
            Action::Prompt {
                message,
                images,
                mode,
            } => {
                crate::images::validate(&images)?;
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
            Action::SetModel { provider, model } => {
                self.rpc(
                    json!({"type":"set_model","provider":provider,"modelId":model}),
                    Kind::Mutate,
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
        self.tx
            .send(Request::Events { ack, reply })
            .await
            .map_err(|_| AppError::new("DISCONNECTED", "Pi 已退出"))?;
        rx.await
            .map_err(|_| AppError::new("DISCONNECTED", "Pi 已退出"))?
    }
    /// 正文只按宿主分配的 ID 读取，不能变成通用文件读取接口。
    pub async fn content(&self, id: String, offset: usize) -> Result<Value> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Request::Content { id, offset, reply })
            .await
            .map_err(|_| AppError::new("DISCONNECTED", "Pi 已退出"))?;
        rx.await
            .map_err(|_| AppError::new("DISCONNECTED", "Pi 已退出"))?
    }
    /// 正常关闭 stdin 并等待，超时回收树；调用方须等待后再创建另一个实例。
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
        if self
            .tx
            .send(Request::Shutdown { force, reply })
            .await
            .is_ok()
        {
            let _ = rx.await;
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
    let handle = Handle {
        id: id.clone(),
        tx,
        lifecycle,
    };
    let projection =
        Projection::with_timing_dir(crate::history::root(settings).join(".desktop-process"));
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
    id: String,
    mut child: Child,
    mut stdin: tokio::process::ChildStdin,
    tree: ProcessTree,
    mut store: Store,
    mut requests: mpsc::Receiver<Request>,
    mut output: mpsc::Receiver<Result<Option<Value>>>,
    channel: Channel<Value>,
    mut projection: Projection,
    lifecycle: watch::Sender<Progress>,
) {
    let mut pending: HashMap<String, Pending> = HashMap::new();
    let mut serial = 0u64;
    let mut restored = false;
    let mut tick = tokio::time::interval(Duration::from_millis(33));
    tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut failure: Option<AppError> = None;
    loop {
        tokio::select! {
            request = requests.recv() => match request {
                Some(Request::Rpc { mut command, kind, reply }) => {
                    // 桥接期间只接受查询与扩展交互响应，禁止命令错误关联和会话并发修改。
                    if !matches!(kind, Kind::Query | Kind::Restore | Kind::Extension) && pending.values().any(|p| p.bridge_command.is_some()) {
                        let _ = reply.send(Err(AppError::new("BUSY", "Pi 桥接操作仍在执行，请稍后再试"))); continue;
                    }
                    if matches!(kind, Kind::Restore) && restored {
                        let before = command["_before"].as_u64().map(|v| v as usize); let _ = reply.send(Ok(projection.page(before))); continue;
                    }
                    serial += 1; let request_id = format!("req-{serial}");
                    // 扩展交互以 Pi 分配的 ID 关联等待者，且不产生普通 RPC 响应。
                    if !matches!(kind, Kind::Extension) { command["id"] = request_id.clone().into(); }
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
                        pending.insert(request_id, Pending { reply, kind, bridge_command, bridge_error: None, deadline: Instant::now()+Duration::from_secs(seconds) });
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
            },
            event = output.recv() => match event {
                Some(Ok(Some(event))) if event["type"] == "response" => {
                    if let Some(request_id) = event["id"].as_str() {
                        if let Some(request) = pending.remove(request_id) {
                            let result = if event["success"] != true { Err(AppError::new("PI_COMMAND", event["error"].as_str().unwrap_or("Pi 拒绝了请求"))) }
                            else if let Some(error) = request.bridge_error { Err(AppError::new("BRIDGE_FAILED", error)) }
                            else if matches!(request.kind, Kind::Bridge | Kind::BridgeRefresh) && event["data"]["disposition"] != "handled" { Err(AppError::new("BRIDGE_PROTOCOL", "桥接命令未被扩展处理，请检查 Pi 版本")) }
                            else if matches!(request.kind, Kind::Restore) {
                                projection.restore(&event["data"], &mut store).map(|()| { restored=true; projection.page(None) })
                            } else { if matches!(request.kind, Kind::Reset | Kind::Refresh | Kind::LongRefresh | Kind::BridgeRefresh) && event["data"]["cancelled"] != true { if matches!(request.kind, Kind::Reset) { projection.reset(); let _ = store.push(json!({"type":"reset"})); } restored=false; } Ok(event["data"].clone()) };
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
                    if event["type"] == "agent_start" { previous.failed = false; }
                    if event["type"] == "message_end" && event["message"]["stopReason"] == "error" {
                        previous.failed = true; lifecycle.send_replace(previous);
                    }
                    let next = match event["type"].as_str() {
                        Some("agent_start" | "auto_retry_start" | "compaction_start") => Some(Lifecycle::Busy),
                        Some("agent_settled") => Some(Lifecycle::Idle),
                        _ => None,
                    };
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
                for request_id in expired { if let Some(p) = pending.remove(&request_id) { let _ = p.reply.send(Err(AppError::new("TIMEOUT", "请求超时，可能已执行；请检查状态，不要自动重发"))); } }
                if store.has_pending() { let _ = channel.send(json!({"type":"available","runtimeId":id})); }
            }
        }
    }
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
