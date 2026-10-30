//! 应用服务入口：Tauri 命令只表达业务意图；平台与协议实现不泄漏到 UI。
mod diagnostics;
mod history;
mod platform;
mod rpc;
mod runtime;
mod settings;
mod storage;
mod tool;
mod types;

use serde_json::{json, Value};
use std::{path::PathBuf, sync::Mutex};
use tauri::{ipc::Channel, Manager, State};
use tokio::sync::Mutex as AsyncMutex;
use types::*;

/// connect/disconnect gate 保护生命周期，不持有普通锁跨 await。
struct AppState {
    config_dir: PathBuf,
    settings: Mutex<Settings>,
    catalog: Mutex<history::Catalog>,
    runtime: AsyncMutex<Option<runtime::Handle>>,
    lifecycle: AsyncMutex<()>,
}
impl AppState {
    /// 克隆句柄后立即释放锁，让响应和停止可并发进入 actor。
    async fn handle(&self) -> Result<runtime::Handle> {
        self.runtime
            .lock()
            .await
            .clone()
            .ok_or_else(|| AppError::new("DISCONNECTED", "请先选择项目并连接 Pi"))
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
        .map_err(|_| AppError::new("LOCK", "配置锁异常"))? = settings;
    Ok(())
}
/// 显式版本探测，无项目时可在设置中运行，不创建会话。
#[tauri::command]
async fn detect_pi(state: State<'_, AppState>, settings: Option<Settings>) -> Result<Value> {
    platform::version(&settings.unwrap_or(state.config()?)).await
}
/// 跨项目先等待回收旧进程，再启动新进程；初始化失败同样回收。
#[tauri::command]
async fn connect_pi(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    project: String,
    channel: Channel<Value>,
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
    if let Some(old) = state.runtime.lock().await.take() {
        let _ = old.shutdown().await;
    }
    let settings = state.config()?;
    let detected = platform::version(&settings).await?;
    let handle = runtime::start(&settings, project.clone(), channel).await?;
    // 提前保存句柄，让启动时扩展的交互响应能送达，避免信任弹窗与初始化互锁。
    *state.runtime.lock().await = Some(handle.clone());
    let init = tokio::time::timeout(std::time::Duration::from_secs(15), async {
        let snapshot = handle.action(Action::State).await?;
        // 历史快照为必需能力；不兼容时在握手阶段回收，而不是留下失败状态的进程。
        handle.action(Action::History { before: None }).await?;
        Ok::<Value, AppError>(snapshot)
    })
    .await;
    let snapshot = match init {
        Ok(Ok(snapshot)) => snapshot,
        other => {
            let _ = handle.shutdown().await;
            *state.runtime.lock().await = None;
            return Err(match other {
                Ok(Err(e)) => e,
                _ => AppError::new("INIT_TIMEOUT", "Pi 初始化超过 15 秒，请检查扩展与运行时"),
            });
        }
    };
    Ok(
        json!({"runtimeId":handle.id,"project":project,"snapshot":snapshot,"version":detected["version"],"verified":detected["verified"]}),
    )
}
/// 正常断开可等待资源释放；再次连接不会与旧实例并存。
#[tauri::command]
async fn disconnect_pi(state: State<'_, AppState>, force: Option<bool>) -> Result<()> {
    let _gate = state.lifecycle.lock().await;
    if let Some(handle) = state.runtime.lock().await.take() {
        let _ = handle.close(force.unwrap_or(false)).await;
    }
    Ok(())
}
/// 白名单业务调用；runtimeId 检查防止旧 UI 请求影响新会话。
#[tauri::command]
async fn perform(state: State<'_, AppState>, runtime_id: String, action: Action) -> Result<Value> {
    let handle = state.handle().await?;
    if handle.id != runtime_id {
        return Err(AppError::new("STALE_RUNTIME", "会话连接已更新"));
    }
    handle.action(action).await
}
/// 可靠批次拉取，前端确认游标才回收 spool。
#[tauri::command]
async fn next_events(state: State<'_, AppState>, runtime_id: String, ack: u64) -> Result<Value> {
    let handle = state.handle().await?;
    if handle.id != runtime_id {
        return Err(AppError::new("STALE_RUNTIME", "会话连接已更新"));
    }
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
    let handle = state.handle().await?;
    if handle.id != runtime_id {
        return Err(AppError::new("STALE_RUNTIME", "正文连接已更新"));
    }
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
                runtime: AsyncMutex::new(None),
                lifecycle: AsyncMutex::new(()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            detect_pi,
            connect_pi,
            disconnect_pi,
            perform,
            next_events,
            read_content,
            list_sessions
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let app = window.app_handle().clone();
                tauri::async_runtime::spawn(async move {
                    let state = app.state::<AppState>();
                    let _gate = state.lifecycle.lock().await;
                    if let Some(handle) = state.runtime.lock().await.take() {
                        let _ = handle.shutdown().await;
                    }
                    app.exit(0);
                });
            }
        })
        .run(tauri::generate_context!())
        .expect("Pi Desktop 启动失败");
}
