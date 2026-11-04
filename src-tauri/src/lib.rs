//! 应用服务入口：Tauri 命令只表达业务意图；平台与协议实现不泄漏到 UI。
mod diagnostics;
mod history;
mod image_picker;
mod images;
mod model_config;
mod model_discovery;
mod new_session;
mod platform;
mod rpc;
mod runtime;
mod settings;
mod storage;
mod supervisor;
mod text_presentation;
mod tool;
mod types;

use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tauri::{ipc::Channel, Manager, State};
use tokio::sync::Mutex as AsyncMutex;
use types::*;

/// connect/disconnect gate 保护生命周期，不持有普通锁跨 await。
struct AppState {
    config_dir: PathBuf,
    settings: Mutex<Settings>,
    catalog: Mutex<history::Catalog>,
    runtimes: Arc<supervisor::Supervisor>,
    sessions: Mutex<HashMap<String, String>>,
    lifecycle: AsyncMutex<()>,
}
impl AppState {
    /// 克隆句柄后立即释放锁，让响应和停止可并发进入 actor。
    async fn handle(&self, id: &str) -> Result<runtime::Handle> {
        self.runtimes.handle(id)
    }
    /// 配置快照不包含任何凭据，普通互斥锁只用于短暂内存读取。
    fn config(&self) -> Result<Settings> {
        self.settings
            .lock()
            .map(|s| s.clone())
            .map_err(|_| AppError::new("LOCK", "配置锁异常"))
    }
}

/// 返回应用配置，不隐式启动 Pi。
#[tauri::command]
fn get_settings(state: State<'_, AppState>) -> Result<Settings> {
    state.config()
}
/// 保存设置后下次连接生效；当前 Agent 环境不被运行中修改。
#[tauri::command]
fn save_settings(state: State<'_, AppState>, settings: Settings) -> Result<()> {
    settings::save(&state.config_dir, &settings)?;
    *state
        .settings
        .lock()
        .map_err(|_| AppError::new("LOCK", "配置锁异常"))? = settings.clone();
    state
        .runtimes
        .set_limit(settings.max_concurrent_tasks as usize);
    Ok(())
}
/// 显式版本探测，无项目时可在设置中运行，不创建会话。
#[tauri::command]
async fn detect_pi(state: State<'_, AppState>, settings: Option<Settings>) -> Result<Value> {
    platform::version(&settings.unwrap_or(state.config()?)).await
}
/// 页面同步只影响缓存资格；业务调度和 Actor 共同确认是否可复用。
#[tauri::command]
async fn sync_process_pool(
    state: State<'_, AppState>,
    revision: u64,
    selected: String,
    eligible: Vec<String>,
) -> Result<()> {
    state
        .runtimes
        .sync_pool(revision, selected, eligible, &state.config()?)
        .await
}
/// 获取会话租约，物理进程可从全局空闲池复用。
#[tauri::command]
async fn connect_pi(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    project: String,
    channel: Channel<Value>,
    session_path: Option<String>,
) -> Result<Value> {
    // 未指定项目时使用系统用户目录，绝不继承应用安装目录。
    let project = if project.is_empty() {
        app.path()
            .home_dir()
            .map_err(|error| AppError::new("HOME", error.to_string()))?
            .to_string_lossy()
            .into_owned()
    } else {
        project
    };
    let _gate = state.lifecycle.lock().await;
    let settings = state.config()?;
    if let Some(path) = session_path.clone() {
        let cwd = tokio::task::spawn_blocking(move || history::session_cwd(&path))
            .await
            .map_err(|_| AppError::new("SESSION_HEADER", "读取会话头失败"))??;
        if session_identity(&cwd)? != session_identity(&project)? {
            return Err(AppError::new(
                "PROJECT_MISMATCH",
                "历史会话不属于所选项目，请刷新侧栏",
            ));
        }
    }
    let detected = platform::version(&settings).await?;
    if let Some(path) = &session_path {
        let key = session_identity(path)?;
        let existing = state.sessions.lock().unwrap().get(&key).cloned();
        if let Some(id) = existing {
            if state
                .runtimes
                .handle(&id)
                .is_ok_and(|handle| handle.lifecycle.borrow().state != runtime::Lifecycle::Stopped)
            {
                return Err(AppError::new("SESSION_OPEN", "该会话已在本窗口中打开"));
            }
            // 崩溃实例不再拥有写权限，清除身份映射以允许显式恢复。
            state.runtimes.remove(&id);
            state.sessions.lock().unwrap().remove(&key);
        }
    }
    // 跨项目复用在真实 Pi 集成测试覆盖后按精确版本开放。
    let cross_project = detected["version"]
        .as_str()
        .is_some_and(|v| v.trim() == "1.5.0");
    let (handle, snapshot, reused) = state
        .runtimes
        .acquire(
            &settings,
            &project,
            session_path.as_deref(),
            channel,
            None,
            cross_project,
        )
        .await?;
    if let Some(path) = snapshot["sessionFile"].as_str() {
        state
            .sessions
            .lock()
            .unwrap()
            .insert(session_identity(path)?, handle.id.clone());
    }
    Ok(
        json!({"runtimeId":handle.id,"leaseId":handle.id,"processId":handle.process_id,"acquisition":if reused { "switched" } else { "started" },"project":project,"snapshot":snapshot,"version":detected["version"],"verified":detected["verified"]}),
    )
}
/// 定向关闭一个运行时，其他项目和会话继续执行。
#[tauri::command]
async fn disconnect_pi(
    state: State<'_, AppState>,
    runtime_id: String,
    force: Option<bool>,
) -> Result<()> {
    let _gate = state.lifecycle.lock().await;
    if let Ok(handle) = state.runtimes.handle(&runtime_id) {
        handle.close(force.unwrap_or(false)).await?;
    }
    state.runtimes.remove(&runtime_id);
    state
        .sessions
        .lock()
        .unwrap()
        .retain(|_, runtime| runtime != &runtime_id);
    state
        .runtimes
        .set_limit(state.config()?.max_concurrent_tasks as usize);
    Ok(())
}
/// 文件存在时使用规范路径；Windows 忽略大小写与分隔符别名。
fn session_identity(path: &str) -> Result<String> {
    let path = PathBuf::from(path);
    let absolute = if path.is_absolute() {
        path
    } else {
        std::env::current_dir()?.join(path)
    };
    let key = std::fs::canonicalize(&absolute)
        .unwrap_or(absolute)
        .to_string_lossy()
        .into_owned();
    #[cfg(windows)]
    let key = {
        let normalized = key.replace('\\', "/").to_lowercase();
        normalized
            .strip_prefix("//?/unc/")
            .map(|unc| format!("//{unc}"))
            .unwrap_or_else(|| normalized.trim_start_matches("//?/").to_owned())
    };
    Ok(key)
}
/// 新会话只在领取执行名额后启动；提交时快照模型和图片，不读取任意文件。
#[tauri::command]
async fn submit_new_task(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    request: NewTaskRequest,
    channel: Channel<Value>,
) -> Result<Value> {
    let NewTaskRequest {
        project,
        submission_id,
        action,
        model,
        thinking,
    } = request;
    if !matches!(action, Action::Prompt { .. }) {
        return Err(AppError::new("TASK", "新会话只接受初始提示词"));
    }
    let project = if project.is_empty() {
        app.path()
            .home_dir()
            .map_err(|_| AppError::new("HOME", "无法读取用户目录"))?
            .to_string_lossy()
            .into_owned()
    } else {
        project
    };
    if !std::path::Path::new(&project).is_dir() {
        return Err(AppError::new("PROJECT", "项目目录不存在"));
    }
    state.runtimes.submit_new(
        submission_id,
        action,
        supervisor::Launch {
            settings: state.config()?,
            project,
            channel,
            model,
            thinking,
        },
    )
}
#[tauri::command]
fn list_activity(state: State<'_, AppState>) -> Vec<supervisor::Activity> {
    state.runtimes.list()
}
#[tauri::command]
fn get_submission(
    state: State<'_, AppState>,
    submission_id: String,
) -> Option<supervisor::Activity> {
    state.runtimes.submission(&submission_id)
}
#[tauri::command]
fn cancel_queued_task(state: State<'_, AppState>, task_id: String) -> Result<()> {
    state.runtimes.cancel(&task_id)
}
#[tauri::command]
fn pause_tasks(state: State<'_, AppState>, paused: bool) {
    state.runtimes.pause(paused);
    if !paused {
        state.runtimes.set_limit(
            state
                .config()
                .map(|s| s.max_concurrent_tasks as usize)
                .unwrap_or(4),
        );
    }
}
#[tauri::command]
async fn exit_app(app: tauri::AppHandle, state: State<'_, AppState>, force: bool) -> Result<()> {
    // 强制退出可越过先前正常关闭的等待，不让同一个生命周期锁屏蔽恢复入口。
    let _gate = if force {
        None
    } else {
        Some(state.lifecycle.lock().await)
    };
    state.runtimes.pause(true);
    state.runtimes.close_all(force).await?;
    app.exit(0);
    Ok(())
}
/// 白名单业务调用；runtimeId 检查防止旧 UI 请求影响新会话。
#[tauri::command]
async fn perform(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    runtime_id: String,
    action: Action,
    submission_id: Option<String>,
) -> Result<Value> {
    if matches!(action, Action::Stop) && state.runtimes.is_running(&runtime_id) {
        state.runtimes.mark_stopping(&runtime_id);
        if state.runtimes.handle(&runtime_id).is_err() {
            return Ok(json!({"steering":[],"followUp":[]}));
        }
    }
    let handle = state.handle(&runtime_id).await?;
    if handle.id != runtime_id {
        return Err(AppError::new("STALE_RUNTIME", "会话连接已更新"));
    }
    if let Some(submission) = &submission_id {
        if let Some(task) = state.runtimes.submission(submission) {
            return Ok(json!({"desktopTask":task.task_id}));
        }
    }
    if let Action::SwitchSession { path } = &action {
        if state
            .sessions
            .lock()
            .unwrap()
            .get(&session_identity(path)?)
            .is_some_and(|owner| owner != &runtime_id)
        {
            return Err(AppError::new(
                "SESSION_OPEN",
                "目标会话已有独立运行实例，请从侧栏打开",
            ));
        }
    }
    if state.runtimes.is_queued(&runtime_id)
        && !matches!(
            action,
            Action::State
                | Action::History { .. }
                | Action::Models
                | Action::ThinkingLevels
                | Action::Commands
                | Action::SessionStats
                | Action::ExtensionResponse { .. }
        )
    {
        return Err(AppError::new("TASK_QUEUED", "会话正在排队，请先取消排队"));
    }
    if matches!(action, Action::Stop) {
        state.runtimes.mark_stopping(&runtime_id);
    }
    if matches!(
        action,
        Action::Prompt { .. }
            | Action::Compact { .. }
            | Action::NavigateTree {
                summarize: true,
                ..
            }
    ) && !state.runtimes.is_running(&runtime_id)
    {
        let submission = submission_id.ok_or_else(|| {
            AppError::new(
                "SUBMISSION_REQUIRED",
                "新任务需要提交标识，请重新打开会话后发送",
            )
        })?;
        return state.runtimes.submit(runtime_id, submission, action);
    }
    if let Action::NewProjectSession { project } = action {
        let project = if project.is_empty() {
            app.path()
                .home_dir()
                .map_err(|error| AppError::new("HOME", error.to_string()))?
                .to_string_lossy()
                .into_owned()
        } else {
            project
        };
        let settings = state.config()?;
        let empty = tokio::task::spawn_blocking(move || {
            new_session::EmptySession::create(&settings, &project)
        })
        .await
        .map_err(|_| AppError::new("SESSION", "创建空白会话失败"))??;
        let result = handle
            .action(Action::SwitchSession {
                path: empty.path.to_string_lossy().into(),
            })
            .await;
        // 超时结果未知时保留文件，避免删掉 Pi 已打开的会话。
        if result
            .as_ref()
            .is_ok_and(|value| value["cancelled"] == true)
        {
            empty.discard_if_empty();
        }
        result
    } else {
        let tracks_session = matches!(action, Action::State);
        let user_action = !matches!(
            action,
            Action::State
                | Action::History { .. }
                | Action::Models
                | Action::ThinkingLevels
                | Action::Commands
                | Action::SessionStats
                | Action::LastAssistant
                | Action::ForkMessages
                | Action::SessionTree
                | Action::ExtensionResponse { .. }
        );
        let result = handle.action(action).await?;
        if user_action {
            state.runtimes.touch(&runtime_id);
        }
        if tracks_session {
            if let Some(path) = result["sessionFile"].as_str() {
                let key = session_identity(path)?;
                let mut sessions = state.sessions.lock().unwrap();
                if sessions.get(&key).is_some_and(|owner| {
                    owner != &runtime_id && state.runtimes.handle(owner).is_ok()
                }) {
                    return Err(AppError::new(
                        "SESSION_OPEN",
                        "该会话已被另一个运行实例打开",
                    ));
                }
                sessions.retain(|_, owner| owner != &runtime_id);
                sessions.insert(key, runtime_id);
            }
        }
        Ok(result)
    }
}
/// 可靠批次拉取，前端确认游标才回收 spool。
#[tauri::command]
async fn next_events(state: State<'_, AppState>, runtime_id: String, ack: u64) -> Result<Value> {
    let handle = state.handle(&runtime_id).await?;
    handle.events(ack).await
}
/// 大正文分页仅接受宿主引用，不接受文件路径。
#[tauri::command]
async fn read_content(
    state: State<'_, AppState>,
    runtime_id: String,
    id: String,
    offset: usize,
) -> Result<Value> {
    let handle = state.handle(&runtime_id).await?;
    handle.content(id, offset).await
}
/// 文件扫描放到 blocking 池，不阻塞 Tokio 管道读取或窗口线程。
#[tauri::command]
async fn list_sessions(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    project: String,
    search: String,
) -> Result<Vec<SessionSummary>> {
    let settings = state.config()?;
    tokio::task::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let mut catalog = state
            .catalog
            .lock()
            .map_err(|_| AppError::new("LOCK", "历史索引锁异常"))?;
        catalog.list(&settings, &project, &search)
    })
    .await
    .map_err(|_| AppError::new("HISTORY", "历史扫描任务异常"))?
}

/// 共享模型配置不要求先启动会话，文件 IO 在 blocking 池执行。
#[tauri::command]
async fn get_model_config(app: tauri::AppHandle) -> Result<model_config::ModelSettings> {
    let home = app
        .path()
        .home_dir()
        .map_err(|_| AppError::new("HOME", "无法读取用户目录"))?;
    tokio::task::spawn_blocking(move || model_config::load(&model_config::directory(&home)))
        .await
        .map_err(|_| AppError::new("MODEL_CONFIG", "读取模型配置任务失败"))?
}
/// 提交版本检查及字段补丁，密钥不经通用 Settings 或诊断接口。
#[tauri::command]
async fn save_model_config(
    app: tauri::AppHandle,
    config: model_config::ModelSettings,
) -> Result<model_config::ModelSettings> {
    let home = app
        .path()
        .home_dir()
        .map_err(|_| AppError::new("HOME", "无法读取用户目录"))?;
    tokio::task::spawn_blocking(move || model_config::save(&model_config::directory(&home), config))
        .await
        .map_err(|_| AppError::new("MODEL_CONFIG", "保存模型配置任务失败，请重新读取确认状态"))?
}
/// 仅执行指定协议的模型发现，不接受任意 HTTP 方法或请求头。
#[tauri::command]
async fn discover_models(
    app: tauri::AppHandle,
    provider: model_config::ProviderConfig,
) -> Result<model_discovery::Discovery> {
    let home = app
        .path()
        .home_dir()
        .map_err(|_| AppError::new("HOME", "无法读取用户目录"))?;
    model_discovery::discover(&model_config::directory(&home), provider).await
}

/// 原生选择和读取合并为专用命令，不接受前端提供的文件路径。
#[tauri::command]
async fn pick_images(app: tauri::AppHandle) -> Result<Vec<Value>> {
    tokio::task::spawn_blocking(move || image_picker::pick(app))
        .await
        .map_err(|_| AppError::new("IMAGE", "图片选择任务失败，请重试。"))?
}

/// 统一安装受限插件和命令；关闭窗口必须先 await 自有进程回收。
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            diagnostics::init(&config_dir);
            let settings = settings::load(&config_dir)?;
            let catalog = history::Catalog::load(&config_dir);
            app.manage(AppState {
                config_dir,
                settings: Mutex::new(settings),
                catalog: Mutex::new(catalog),
                runtimes: Arc::new(supervisor::Supervisor::default()),
                sessions: Mutex::new(HashMap::new()),
                lifecycle: AsyncMutex::new(()),
            });
            let state = app.state::<AppState>();
            state
                .runtimes
                .set_limit(state.config()?.max_concurrent_tasks as usize);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            pick_images,
            save_settings,
            get_model_config,
            save_model_config,
            discover_models,
            detect_pi,
            connect_pi,
            sync_process_pool,
            disconnect_pi,
            list_activity,
            submit_new_task,
            cancel_queued_task,
            get_submission,
            pause_tasks,
            exit_app,
            perform,
            next_events,
            read_content,
            list_sessions
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                // 关闭请求交给页内确认条；确认后由 exit_app 回收各自进程树。
                use tauri::Emitter;
                let _ = window.emit("desktop-close-requested", ());
            }
        })
        .run(tauri::generate_context!())
        .expect("Pi Desktop 启动失败");
}
