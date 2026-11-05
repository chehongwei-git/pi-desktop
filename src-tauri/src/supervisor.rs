//! 跨项目调度器：短锁保护队列和名额，RPC 与进程等待始终在锁外执行。
use crate::{runtime, types::*};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::{Arc, Mutex},
};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    pub task_id: String,
    pub runtime_id: String,
    pub state: String,
    pub position: usize,
    pub error: Option<String>,
}
/// 新草稿在队列中只持有启动快照和受控 Channel，不拥有操作系统进程。
pub struct Launch {
    pub settings: Settings,
    pub project: String,
    pub channel: tauri::ipc::Channel<Value>,
    pub model: Option<(String, String)>,
    pub thinking: Option<String>,
}
struct Job {
    id: String,
    runtime: String,
    action: Action,
    launch: Option<Launch>,
}
struct PoolEntry {
    project: String,
    config: String,
    cross_project: bool,
    used: u64,
    eligible: bool,
    reserved: bool,
}
#[derive(Default)]
struct Inner {
    handles: HashMap<String, runtime::Handle>,
    pool: HashMap<String, PoolEntry>,
    pool_revision: u64,
    use_serial: u64,
    selected: String,
    pending_leases: HashMap<String, tokio::sync::watch::Receiver<()>>,
    tasks: HashMap<String, Activity>,
    submissions: HashMap<String, String>,
    stopping: HashSet<String>,
    launching: HashSet<String>,
    queue: VecDeque<Job>,
    serial: u64,
    limit: usize,
    closing: bool,
}
#[derive(Default)]
pub struct Supervisor {
    inner: Mutex<Inner>,
    // 仅串行化缓存回收，避免导航在前一次关闭尚未完成时误认为租约仍可用。
    maintenance: tokio::sync::Mutex<()>,
}
impl Supervisor {
    /// 启动配置只在内存比较，不含凭据，不写入日志。
    fn config_key(settings: &Settings) -> String {
        serde_json::to_string(&(
            &settings.pi_path,
            &settings.runtime_path,
            &settings.extra_path,
            &settings.session_dir,
        ))
        .unwrap()
    }
    fn project_key(project: &str) -> String {
        crate::session_identity(project).unwrap_or_else(|_| project.into())
    }
    fn available(inner: &Inner, id: &str, entry: &PoolEntry) -> bool {
        entry.eligible
            && !entry.reserved
            && inner.selected != id
            && !inner
                .tasks
                .values()
                .any(|t| t.runtime_id == id && matches!(t.state.as_str(), "queued" | "running"))
            && inner
                .handles
                .get(id)
                .is_some_and(|h| h.lifecycle.borrow().state == runtime::Lifecycle::Idle)
    }
    /// 页面只上报可借用资格，宿主仍复核任务、Actor 与租约；旧导航快照不能覆盖新选择。
    pub async fn sync_pool(
        &self,
        revision: u64,
        selected: String,
        eligible: Vec<String>,
        settings: &Settings,
    ) -> Result<()> {
        let _maintenance = self.maintenance.lock().await;
        let (victims, pending_selection) = {
            let mut inner = self.inner.lock().unwrap();
            if revision <= inner.pool_revision {
                return Ok(());
            }
            inner.pool_revision = revision;
            if inner.selected != selected {
                inner.use_serial += 1;
                let used = inner.use_serial;
                if let Some(entry) = inner.pool.get_mut(&selected) {
                    entry.used = used;
                }
            }
            inner.selected = selected.clone();
            inner
                .pending_leases
                .retain(|_, pending| pending.has_changed().is_ok());
            let pending_selection = inner.pending_leases.get(&selected).cloned();
            for (id, entry) in &mut inner.pool {
                entry.eligible = eligible.contains(id);
            }
            let config = Self::config_key(settings);
            let idle_count = inner
                .pool
                .iter()
                .filter(|(id, e)| {
                    !e.reserved
                        && inner
                            .handles
                            .get(*id)
                            .is_some_and(|h| h.lifecycle.borrow().state == runtime::Lifecycle::Idle)
                })
                .count();
            let mut excess = idle_count.saturating_sub(settings.idle_process_limit as usize);
            let mut candidates: Vec<_> = inner
                .pool
                .iter()
                .filter(|(id, e)| Self::available(&inner, id, e))
                .map(|(id, e)| (id.clone(), e.used, e.config != config))
                .collect();
            candidates.sort_by_key(|(_, used, _)| *used);
            let mut victims = Vec::new();
            for (id, _, obsolete) in candidates {
                if excess == 0 && !obsolete {
                    continue;
                }
                if let Some(entry) = inner.pool.get_mut(&id) {
                    entry.reserved = true;
                }
                if let Some(handle) = inner.handles.get(&id) {
                    victims.push(handle.clone());
                }
                excess = excess.saturating_sub(1);
            }
            (victims, pending_selection)
        };
        for handle in victims {
            // Actor 的重新绑定是最后一道空闲屏障，也使迟到关闭请求不能关闭下一租约。
            let retired = match handle
                .rebind(
                    format!("retired-{}", uuid::Uuid::new_v4()),
                    handle.channel.clone(),
                )
                .await
            {
                Ok(retired) => retired,
                Err(_) => {
                    if let Some(e) = self.inner.lock().unwrap().pool.get_mut(&handle.id) {
                        e.reserved = false;
                    }
                    continue;
                }
            };
            retired.close(false).await?;
            self.remove(&handle.id);
            handle.notify_released();
        }
        // 仅等待被选中的旧租约；其他项目的启动和导航不互相阻塞。
        drop(_maintenance);
        if let Some(mut pending) = pending_selection {
            let _ = pending.changed().await;
        }
        Ok(())
    }
    /// 原子预留候选后在锁外切换；新建优先复用，历史在额度内按需增长。
    pub async fn acquire(
        self: &Arc<Self>,
        settings: &Settings,
        project: &str,
        path: Option<&str>,
        channel: tauri::ipc::Channel<Value>,
        id: Option<String>,
        cross_project: bool,
    ) -> Result<(runtime::Handle, Value, bool)> {
        // 通道关闭代表本次获取结束；只让重访被借用租约的导航等待。
        let (_completion, completion) = tokio::sync::watch::channel(());
        let project_key = Self::project_key(project);
        let config = Self::config_key(settings);
        let target_id = id.unwrap_or_else(|| format!("lease-{}", uuid::Uuid::new_v4()));
        let mut previous = {
            let mut inner = self.inner.lock().unwrap();
            if inner.closing {
                return Err(AppError::new("CLOSING", "应用正在退出"));
            }
            let count = inner
                .pool
                .iter()
                .filter(|(id, e)| {
                    e.reserved
                        || inner
                            .handles
                            .get(*id)
                            .is_some_and(|h| h.lifecycle.borrow().state == runtime::Lifecycle::Idle)
                })
                .count();
            let candidate = if path.is_none() || count >= settings.idle_process_limit as usize {
                inner
                    .pool
                    .iter()
                    .filter(|(id, e)| {
                        Self::available(&inner, id, e)
                            && e.config == config
                            && (e.project == project_key
                                || (path.is_some() && cross_project && e.cross_project))
                    })
                    .min_by_key(|(_, e)| (e.project != project_key, e.used))
                    .map(|(id, _)| id.clone())
            } else {
                None
            };
            if let Some(old) = &candidate {
                inner.pending_leases.insert(old.clone(), completion);
            }
            let previous = candidate
                .and_then(|id| Some((inner.handles.remove(&id)?, inner.pool.remove(&id)?)));
            inner.use_serial += 1;
            let used = inner.use_serial;
            inner.pool.insert(
                target_id.clone(),
                PoolEntry {
                    project: project_key.clone(),
                    config,
                    cross_project,
                    used,
                    eligible: false,
                    reserved: true,
                },
            );
            previous
        };
        let mut reused = previous.is_some();
        let _ = channel.send(json!({"type":"acquiring", "runtimeId":target_id, "phase":if !reused { "started" } else if path.is_some() { "opened" } else { "created" }}));
        let mut handle_result = if let Some((old, _)) = &previous {
            old.rebind(target_id.clone(), channel.clone()).await
        } else {
            runtime::start_reserved(
                settings,
                project.into(),
                channel.clone(),
                Some(target_id.clone()),
            )
            .await
        };
        // 前端资格可能落后于后台动作，Actor 拒绝借用时启动独立进程，不重发任何业务动作。
        if handle_result
            .as_ref()
            .is_err_and(|error| error.code == "BUSY")
        {
            if let Some((old, mut entry)) = previous.take() {
                entry.eligible = false;
                let mut inner = self.inner.lock().unwrap();
                inner.pool.insert(old.id.clone(), entry);
                inner.handles.insert(old.id.clone(), old);
            }
            reused = false;
            let _ =
                channel.send(json!({"type":"acquiring", "runtimeId":target_id, "phase":"started"}));
            handle_result = runtime::start_reserved(
                settings,
                project.into(),
                channel.clone(),
                Some(target_id.clone()),
            )
            .await;
        }
        let handle = match handle_result {
            Ok(handle) => handle,
            Err(error) => {
                self.remove(&target_id);
                if let Some((old, entry)) = previous {
                    let mut inner = self.inner.lock().unwrap();
                    inner.pool.insert(old.id.clone(), entry);
                    inner.handles.insert(old.id.clone(), old);
                }
                return Err(error);
            }
        };
        self.register(handle.clone());
        let init = tokio::time::timeout(std::time::Duration::from_secs(30), async {
            let switched = if let Some(path) = path {
                handle
                    .action(Action::SwitchSession { path: path.into() })
                    .await?
            } else if reused {
                handle.action(Action::NewSession).await?
            } else {
                Value::Null
            };
            if switched["cancelled"] == true {
                return Err(AppError::new("CANCELLED", "扩展取消了会话切换"));
            }
            let snapshot = handle.action(Action::State).await?;
            if let Some(cwd) = snapshot["cwd"].as_str() {
                if Self::project_key(cwd) != project_key {
                    return Err(AppError::new("PROJECT_MISMATCH", "Pi 返回的项目目录不匹配"));
                }
            }
            if let Some(path) = path {
                if snapshot["sessionFile"].as_str().map(Self::project_key)
                    != Some(Self::project_key(path))
                {
                    return Err(AppError::new("SESSION_MISMATCH", "Pi 返回的会话不匹配"));
                }
            }
            let commands = handle.action(Action::Commands).await?;
            if !commands["commands"].as_array().is_some_and(|commands| {
                commands.iter().any(|command| {
                    command["name"] == "pi-desktop-models-v1" && command["source"] == "extension"
                })
            }) {
                return Err(AppError::new(
                    "BRIDGE_UNAVAILABLE",
                    "Pi 桌面桥接未加载，输入已保留",
                ));
            }
            handle.action(Action::History { before: None }).await?;
            Ok(snapshot)
        })
        .await
        .unwrap_or_else(|_| Err(AppError::new("INIT_TIMEOUT", "Pi 初始化超时，输入已保留")));
        match init {
            Ok(snapshot) => {
                if self.inner.lock().unwrap().closing {
                    let _ = handle.close(true).await;
                    self.remove(&target_id);
                    if let Some((old, _)) = previous {
                        old.notify_released();
                    }
                    return Err(AppError::new("CLOSING", "应用正在退出"));
                }
                if let Some((old, _)) = previous {
                    old.notify_released();
                }
                if let Some(entry) = self.inner.lock().unwrap().pool.get_mut(&target_id) {
                    entry.reserved = false;
                }
                Ok((handle, snapshot, reused))
            }
            Err(error) => {
                if error.code == "CANCELLED" {
                    if let Some((old, entry)) = previous {
                        if let Ok(restored) =
                            handle.rebind(old.id.clone(), old.channel.clone()).await
                        {
                            self.remove(&target_id);
                            let mut inner = self.inner.lock().unwrap();
                            inner.pool.insert(old.id.clone(), entry);
                            inner.handles.insert(old.id.clone(), restored);
                            return Err(error);
                        }
                        old.notify_released();
                    }
                } else if let Some((old, _)) = previous {
                    old.notify_released();
                }
                let _ = handle.close(true).await;
                self.remove(&target_id);
                Err(error)
            }
        }
    }
    pub fn register(&self, handle: runtime::Handle) {
        self.inner
            .lock()
            .unwrap()
            .handles
            .insert(handle.id.clone(), handle);
    }
    pub fn handle(&self, id: &str) -> Result<runtime::Handle> {
        self.inner
            .lock()
            .unwrap()
            .handles
            .get(id)
            .cloned()
            .ok_or_else(|| AppError::new("STALE_RUNTIME", "会话连接已关闭，请重新打开"))
    }
    pub fn remove(&self, id: &str) -> Option<runtime::Handle> {
        let mut inner = self.inner.lock().unwrap();
        inner.queue.retain(|job| job.runtime != id);
        for task in inner.tasks.values_mut().filter(|task| {
            task.runtime_id == id && matches!(task.state.as_str(), "queued" | "running")
        }) {
            task.state = "failed".into();
            task.error = Some("会话连接已关闭".into());
        }
        inner.pool.remove(id);
        inner.handles.remove(id)
    }
    /// 用户业务使用更新 LRU；轮询和事件读取不调用，避免后台活动挤掉常用会话。
    pub fn touch(&self, id: &str) {
        let mut inner = self.inner.lock().unwrap();
        inner.use_serial += 1;
        let used = inner.use_serial;
        if let Some(entry) = inner.pool.get_mut(id) {
            entry.used = used;
        }
    }
    pub fn submission(&self, id: &str) -> Option<Activity> {
        let inner = self.inner.lock().unwrap();
        inner
            .submissions
            .get(id)
            .and_then(|task| inner.tasks.get(task))
            .cloned()
    }
    pub fn list(&self) -> Vec<Activity> {
        let inner = self.inner.lock().unwrap();
        let mut tasks: Vec<_> = inner.tasks.values().cloned().collect();
        for task in &mut tasks {
            task.position = inner
                .queue
                .iter()
                .position(|job| job.id == task.task_id)
                .map_or(0, |i| i + 1);
        }
        tasks
    }
    pub fn set_limit(self: &Arc<Self>, limit: usize) {
        self.inner.lock().unwrap().limit = limit.clamp(1, 16);
        self.dispatch();
    }
    /// 提交去重只覆盖当前应用生命周期；任何未知结果均不隐式重新发送。
    pub fn submit(
        self: &Arc<Self>,
        runtime: String,
        submission: String,
        action: Action,
    ) -> Result<Value> {
        let id;
        {
            let mut inner = self.inner.lock().unwrap();
            if inner.closing {
                return Err(AppError::new("CLOSING", "正在退出，任务未提交"));
            }
            if let Some(id) = inner.submissions.get(&submission) {
                return Ok(json!({"desktopTask":id}));
            }
            if !inner.handles.contains_key(&runtime) {
                return Err(AppError::new("DISCONNECTED", "会话未连接"));
            }
            if inner.tasks.values().any(|task| {
                task.runtime_id == runtime && matches!(task.state.as_str(), "queued" | "running")
            }) {
                return Err(AppError::new("BUSY", "该会话已有待处理任务"));
            }
            if inner.queue.len() >= 100 {
                return Err(AppError::new(
                    "QUEUE_FULL",
                    "等待队列已满，请稍后发送；输入已保留",
                ));
            }
            inner.serial += 1;
            id = format!("task-{}", inner.serial);
            inner.submissions.insert(submission, id.clone());
            // 每个运行时仅保留最近一次执行摘要，避免长时间运行累积任务正文。
            inner.tasks.retain(|_, task| task.runtime_id != runtime);
            inner.tasks.insert(
                id.clone(),
                Activity {
                    task_id: id.clone(),
                    runtime_id: runtime.clone(),
                    state: "queued".into(),
                    position: 0,
                    error: None,
                },
            );
            inner.use_serial += 1;
            let used = inner.use_serial;
            if let Some(entry) = inner.pool.get_mut(&runtime) {
                entry.used = used;
            }
            inner.queue.push_back(Job {
                id: id.clone(),
                runtime,
                action,
                launch: None,
            });
        }
        self.dispatch();
        Ok(json!({"desktopTask":id}))
    }
    pub fn submit_new(
        self: &Arc<Self>,
        submission: String,
        action: Action,
        launch: Launch,
    ) -> Result<Value> {
        let (id, runtime);
        {
            let mut inner = self.inner.lock().unwrap();
            if inner.closing {
                return Err(AppError::new("CLOSING", "正在退出，任务未提交"));
            }
            if let Some(id) = inner.submissions.get(&submission) {
                let task = inner.tasks.get(id).ok_or_else(|| {
                    AppError::new("TASK_EXPIRED", "提交记录已过期，请查看会话历史")
                })?;
                return Ok(json!({"desktopTask":id,"runtimeId":task.runtime_id}));
            }
            if inner.queue.len() >= 100 {
                return Err(AppError::new("QUEUE_FULL", "等待队列已满，输入已保留"));
            }
            inner.serial += 1;
            id = format!("task-{}", inner.serial);
            runtime = format!("reserved-{}", inner.serial);
            inner.submissions.insert(submission, id.clone());
            inner.tasks.insert(
                id.clone(),
                Activity {
                    task_id: id.clone(),
                    runtime_id: runtime.clone(),
                    state: "queued".into(),
                    position: 0,
                    error: None,
                },
            );
            inner.queue.push_back(Job {
                id: id.clone(),
                runtime: runtime.clone(),
                action,
                launch: Some(launch),
            });
        }
        self.dispatch();
        Ok(json!({"desktopTask":id,"runtimeId":runtime}))
    }
    pub fn is_queued(&self, runtime: &str) -> bool {
        self.inner
            .lock()
            .unwrap()
            .tasks
            .values()
            .any(|task| task.runtime_id == runtime && task.state == "queued")
    }
    pub fn is_running(&self, runtime: &str) -> bool {
        self.inner
            .lock()
            .unwrap()
            .tasks
            .values()
            .any(|task| task.runtime_id == runtime && task.state == "running")
    }
    pub fn mark_stopping(&self, runtime: &str) {
        let mut inner = self.inner.lock().unwrap();
        if inner
            .tasks
            .values()
            .any(|task| task.runtime_id == runtime && task.state == "running")
        {
            inner.stopping.insert(runtime.into());
        }
    }
    fn stopping(&self, runtime: &str) -> bool {
        self.inner.lock().unwrap().stopping.contains(runtime)
    }
    pub fn cancel(self: &Arc<Self>, id: &str) -> Result<()> {
        {
            let mut inner = self.inner.lock().unwrap();
            let task = inner
                .tasks
                .get(id)
                .ok_or_else(|| AppError::new("TASK", "任务不存在"))?;
            if task.state != "queued" {
                return Err(AppError::new("TASK_STARTED", "任务已开始，请使用停止任务"));
            }
            inner.queue.retain(|job| job.id != id);
            inner.tasks.get_mut(id).unwrap().state = "cancelled".into();
        }
        self.dispatch();
        Ok(())
    }
    pub fn pause(&self, closing: bool) {
        self.inner.lock().unwrap().closing = closing;
    }
    pub fn handles(&self) -> Vec<runtime::Handle> {
        self.inner
            .lock()
            .unwrap()
            .handles
            .values()
            .cloned()
            .collect()
    }
    /// 退出时同时等待启动中的实例，防止枚举句柄后又出现孤立子进程。
    pub async fn close_all(&self, force: bool) -> Result<()> {
        self.pause(true);
        tokio::time::timeout(std::time::Duration::from_secs(35), async {
            loop {
                for handle in self.handles() {
                    let _ = handle.close(force).await;
                    self.remove(&handle.id);
                }
                let settled = {
                    let inner = self.inner.lock().unwrap();
                    inner.launching.is_empty() && !inner.pool.values().any(|entry| entry.reserved)
                };
                if settled {
                    return Ok(());
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap_or_else(|_| {
            Err(AppError::new(
                "EXIT_TIMEOUT",
                "仍有会话正在关闭，可重试强制退出",
            ))
        })
    }
    /// 初始化失败回收仅属于此任务的进程；启动期间扩展交互仍通过注册表响应。
    async fn launch(self: &Arc<Self>, runtime: &str, launch: Launch) -> Result<runtime::Handle> {
        if self.inner.lock().unwrap().closing {
            return Err(AppError::new("CLOSING", "应用正在退出，任务未启动"));
        }
        let version = crate::platform::version(&launch.settings).await?;
        let cross_project = version["version"]
            .as_str()
            .is_some_and(|v| v.trim() == "1.5.0");
        let (handle, _, _) = self
            .acquire(
                &launch.settings,
                &launch.project,
                None,
                launch.channel.clone(),
                Some(runtime.into()),
                cross_project,
            )
            .await?;
        if self.inner.lock().unwrap().closing {
            let _ = handle.close(true).await;
            self.remove(runtime);
            return Err(AppError::new("CLOSING", "应用正在退出"));
        }
        let init = tokio::time::timeout(std::time::Duration::from_secs(30), async {
            if let Some((provider, model)) = launch.model {
                handle
                    .action(Action::SetModel {
                        provider,
                        model,
                        thinking: launch.thinking.clone(),
                    })
                    .await?;
            }
            if let Some(level) = launch.thinking {
                handle.action(Action::SetThinking { level }).await?;
            }
            let snapshot = handle.action(Action::State).await?;
            handle.action(Action::History { before: None }).await?;
            Ok::<_, AppError>(snapshot)
        })
        .await
        .unwrap_or_else(|_| Err(AppError::new("INIT_TIMEOUT", "Pi 初始化超时，任务未发送")));
        match init {
            Ok(snapshot) => {
                if self.stopping(runtime) {
                    let _ = handle.close(true).await;
                    self.remove(runtime);
                    return Err(AppError::new("STOPPED", "启动已取消，任务未发送"));
                }
                let _ = launch.channel.send(json!({"type":"initialized","runtimeId":runtime,"snapshot":snapshot,"project":launch.project}));
                Ok(handle)
            }
            Err(error) => {
                let _ = handle.close(true).await;
                self.remove(runtime);
                Err(error)
            }
        }
    }
    fn dispatch(self: &Arc<Self>) {
        loop {
            let work = {
                let mut inner = self.inner.lock().unwrap();
                let active = inner
                    .tasks
                    .values()
                    .filter(|task| task.state == "running")
                    .count();
                if inner.closing || active >= inner.limit.max(1) {
                    return;
                }
                let Some(job) = inner.queue.pop_front() else {
                    return;
                };
                let handle = inner.handles.get(&job.runtime).cloned();
                inner.tasks.get_mut(&job.id).unwrap().state = "running".into();
                if job.launch.is_some() {
                    inner.launching.insert(job.runtime.clone());
                }
                (job, handle)
            };
            let owner = self.clone();
            tauri::async_runtime::spawn(async move {
                let (job, handle) = work;
                let result = if let Some(launch) = job.launch {
                    let launched = owner.launch(&job.runtime, launch).await;
                    owner.inner.lock().unwrap().launching.remove(&job.runtime);
                    match launched {
                        Ok(handle) => {
                            if owner.inner.lock().unwrap().closing {
                                Err(AppError::new("CLOSING", "应用正在退出"))
                            } else {
                                execute(handle, job.action).await
                            }
                        }
                        Err(error) => Err(error),
                    }
                } else {
                    match handle {
                        Some(handle) => execute(handle, job.action).await,
                        None => Err(AppError::new("DISCONNECTED", "会话已关闭")),
                    }
                };
                {
                    let mut inner = owner.inner.lock().unwrap();
                    let stopped = inner.stopping.remove(&job.runtime);
                    if inner.handles.get(&job.runtime).is_some_and(|handle| {
                        handle.lifecycle.borrow().state == runtime::Lifecycle::Stopped
                    }) {
                        inner.handles.remove(&job.runtime);
                    }
                    if let Some(task) = inner.tasks.get_mut(&job.id) {
                        task.state = if stopped {
                            "stopped"
                        } else if result.is_err() {
                            "failed"
                        } else {
                            "completed"
                        }
                        .into();
                        task.error = if stopped {
                            None
                        } else {
                            result.err().map(|error| error.message)
                        };
                    }
                }
                owner.dispatch();
            });
        }
    }
}
/// actor 的生命周期信号独立于 UI ack；prompt 回执本身不代表任务完成。
async fn execute(handle: runtime::Handle, action: Action) -> Result<()> {
    let mut lifecycle = handle.lifecycle.clone();
    let before = lifecycle.borrow_and_update().settled;
    let manual_compact = matches!(action, Action::Compact { .. } | Action::NavigateTree { .. });
    let result = handle.action(action).await;
    if let Err(error) = &result {
        if error.code != "TIMEOUT" {
            if matches!(
                error.code.as_str(),
                "PIPE" | "DISCONNECTED" | "PROCESS_EXIT"
            ) {
                let _ = handle.close(true).await;
            }
            return result.map(|_| ());
        }
    }
    // 扩展命令被明确处理且没有启动 Agent 时无需等待 settled。
    let handled = result
        .as_ref()
        .is_ok_and(|value| value["disposition"] == "handled");
    if manual_compact || handled {
        if let Ok(state) = handle.action(Action::State).await {
            if state["isStreaming"] != true && state["isCompacting"] != true {
                return result.map(|_| ());
            }
        }
    }
    loop {
        let progress = *lifecycle.borrow_and_update();
        if progress.state == runtime::Lifecycle::Stopped {
            return Err(AppError::new("PROCESS_EXIT", "Pi 进程已退出"));
        }
        if progress.settled > before {
            // settled 后排队消息可能立刻进入下一轮，查询 Pi 队列确认链真正空闲。
            let state = handle.action(Action::State).await?;
            if state["isStreaming"] != true
                && state["isCompacting"] != true
                && state["pendingMessageCount"].as_u64().unwrap_or(0) == 0
            {
                if progress.failed {
                    return Err(AppError::new(
                        "AGENT_FAILED",
                        "助手执行失败，请查看该会话中的错误详情",
                    ));
                }
                return result.map(|_| ());
            }
        }
        lifecycle
            .changed()
            .await
            .map_err(|_| AppError::new("PROCESS_EXIT", "Pi 进程已退出"))?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pool_settings() -> Settings {
        Settings {
            pi_path: std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap()
                .join("tests/fixtures/mock-pi.mjs")
                .to_string_lossy()
                .into(),
            ..Settings::default()
        }
    }
    fn channel() -> tauri::ipc::Channel<Value> {
        tauri::ipc::Channel::new(|_| Ok(()))
    }

    /// 新建不受未满额度影响；旧句柄即使已克隆也不能跨租约读取、发送或关闭。
    #[tokio::test]
    async fn pool_new_reuses_and_rejects_old_requests() {
        let project = tempfile::tempdir().unwrap();
        let project = project.path().to_str().unwrap();
        let settings = pool_settings();
        let owner = Arc::new(Supervisor::default());
        let (old, _, reused) = owner
            .acquire(&settings, project, None, channel(), None, false)
            .await
            .unwrap();
        assert!(!reused);
        owner
            .sync_pool(1, String::new(), vec![old.id.clone()], &settings)
            .await
            .unwrap();
        let (next, snapshot, reused) = owner
            .acquire(&settings, project, None, channel(), None, false)
            .await
            .unwrap();
        assert!(reused);
        assert_eq!(old.process_id, next.process_id);
        assert_ne!(old.id, next.id);
        assert_eq!(snapshot["newCount"], 1);
        assert_eq!(snapshot["switchCount"], 0);
        assert!(old.action(Action::State).await.is_err());
        assert!(old.events(u64::MAX).await.is_err());
        assert!(old.content("body-1".into(), 0).await.is_err());
        assert!(old.close(true).await.is_err());
        assert!(next.action(Action::State).await.is_ok());
        owner.close_all(true).await.unwrap();
    }

    #[tokio::test]
    async fn pool_navigation_waits_only_for_borrowed_lease() {
        let project = tempfile::tempdir().unwrap();
        let cwd = project.path().to_string_lossy().into_owned();
        let settings = pool_settings();
        let owner = Arc::new(Supervisor::default());
        let (old, _, _) = owner
            .acquire(&settings, &cwd, None, channel(), None, false)
            .await
            .unwrap();
        old.action(Action::Rename {
            name: "slow-new".into(),
        })
        .await
        .unwrap();
        owner
            .sync_pool(1, String::new(), vec![old.id.clone()], &settings)
            .await
            .unwrap();
        let acquiring = {
            let owner = owner.clone();
            let settings = settings.clone();
            tokio::spawn(async move {
                owner
                    .acquire(&settings, &cwd, None, channel(), None, false)
                    .await
            })
        };
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while owner.handle(&old.id).is_ok() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        // 无关导航不等待切换；原租约导航等到切换结束才返回。
        tokio::time::timeout(
            std::time::Duration::from_millis(100),
            owner.sync_pool(2, String::new(), vec![], &settings),
        )
        .await
        .unwrap()
        .unwrap();
        owner
            .sync_pool(3, old.id.clone(), vec![], &settings)
            .await
            .unwrap();
        let (next, _, reused) = acquiring.await.unwrap().unwrap();
        assert!(reused);
        assert!(old.action(Action::State).await.is_err());
        assert!(next.action(Action::State).await.is_ok());
        owner.close_all(true).await.unwrap();
    }

    /// 即使前端尚未看见扩展请求，Actor 也不允许借走正在等待回答的进程。
    #[tokio::test]
    async fn pool_stale_eligibility_does_not_steal_extension_wait() {
        let project = tempfile::tempdir().unwrap();
        let cwd = project.path().to_str().unwrap();
        let settings = pool_settings();
        let owner = Arc::new(Supervisor::default());
        let (old, _, _) = owner
            .acquire(&settings, cwd, None, channel(), None, false)
            .await
            .unwrap();
        old.action(Action::Rename {
            name: "plan-dialog".into(),
        })
        .await
        .unwrap();
        owner
            .sync_pool(1, String::new(), vec![old.id.clone()], &settings)
            .await
            .unwrap();
        let stopping = {
            let old = old.clone();
            tokio::spawn(async move { old.action(Action::Stop).await })
        };
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                let batch = old.events(0).await.unwrap();
                if batch["events"]
                    .as_array()
                    .is_some_and(|events| events.iter().any(|e| e["type"] == "extension"))
                {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        let (next, _, reused) = owner
            .acquire(&settings, cwd, None, channel(), None, false)
            .await
            .unwrap();
        assert!(!reused);
        assert_ne!(next.process_id, old.process_id);
        old.action(Action::ExtensionResponse {
            id: "pi-plan-choice".into(),
            value: json!({"cancelled":true}),
        })
        .await
        .unwrap();
        stopping.await.unwrap().unwrap();
        owner.close_all(true).await.unwrap();
    }

    #[tokio::test]
    async fn pool_cancellation_restores_original_binding() {
        let project = tempfile::tempdir().unwrap();
        let settings = pool_settings();
        let owner = Arc::new(Supervisor::default());
        let (old, _, _) = owner
            .acquire(
                &settings,
                project.path().to_str().unwrap(),
                None,
                channel(),
                None,
                false,
            )
            .await
            .unwrap();
        old.action(Action::Rename {
            name: "cancel-new".into(),
        })
        .await
        .unwrap();
        owner
            .sync_pool(1, String::new(), vec![old.id.clone()], &settings)
            .await
            .unwrap();
        let error = owner
            .acquire(
                &settings,
                project.path().to_str().unwrap(),
                None,
                channel(),
                None,
                false,
            )
            .await
            .err()
            .unwrap();
        assert_eq!(error.code, "CANCELLED");
        assert!(owner.handle(&old.id).is_ok());
        assert_eq!(old.action(Action::State).await.unwrap()["newCount"], 0);
        assert!(old.events(0).await.is_ok());
        owner.close_all(true).await.unwrap();
    }

    /// 历史在额度内增长，满额复用 LRU；零额度只回收后台，不回收当前。
    #[tokio::test]
    async fn pool_history_capacity_lru_and_zero_limit() {
        let project = tempfile::tempdir().unwrap();
        let cwd = project.path().to_str().unwrap();
        let mut settings = pool_settings();
        settings.idle_process_limit = 2;
        let owner = Arc::new(Supervisor::default());
        let (a, _, _) = owner
            .acquire(&settings, cwd, Some("a.jsonl"), channel(), None, false)
            .await
            .unwrap();
        owner
            .sync_pool(1, String::new(), vec![a.id.clone()], &settings)
            .await
            .unwrap();
        let (b, _, reused) = owner
            .acquire(&settings, cwd, Some("b.jsonl"), channel(), None, false)
            .await
            .unwrap();
        assert!(!reused);
        assert_ne!(a.process_id, b.process_id);
        owner
            .sync_pool(2, b.id.clone(), vec![a.id.clone()], &settings)
            .await
            .unwrap();
        let (c, _, reused) = owner
            .acquire(&settings, cwd, Some("c.jsonl"), channel(), None, false)
            .await
            .unwrap();
        assert!(reused);
        assert_eq!(a.process_id, c.process_id);
        assert_eq!(owner.handles().len(), 2);
        settings.idle_process_limit = 0;
        owner
            .sync_pool(3, c.id.clone(), vec![b.id.clone()], &settings)
            .await
            .unwrap();
        assert!(owner.handle(&b.id).is_err());
        assert!(c.action(Action::State).await.is_ok());
        owner.close_all(true).await.unwrap();
    }

    #[tokio::test]
    async fn pool_cross_project_new_starts_and_config_change_retires_idle() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let mut settings = pool_settings();
        let owner = Arc::new(Supervisor::default());
        let (first, _, _) = owner
            .acquire(
                &settings,
                a.path().to_str().unwrap(),
                None,
                channel(),
                None,
                false,
            )
            .await
            .unwrap();
        owner
            .sync_pool(1, String::new(), vec![first.id.clone()], &settings)
            .await
            .unwrap();
        let (second, _, reused) = owner
            .acquire(
                &settings,
                b.path().to_str().unwrap(),
                None,
                channel(),
                None,
                false,
            )
            .await
            .unwrap();
        assert!(!reused);
        assert_ne!(first.process_id, second.process_id);
        settings.session_dir = b.path().to_string_lossy().into();
        owner
            .sync_pool(2, second.id.clone(), vec![first.id.clone()], &settings)
            .await
            .unwrap();
        assert!(owner.handle(&first.id).is_err());
        owner.close_all(true).await.unwrap();
    }

    /// 两个真实项目目录各两个会话占满四个名额，第五个只在 settled 后开始。
    #[tokio::test]
    async fn cross_project_fifo_waits_for_settled_and_deduplicates() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap();
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let settings = Settings {
            pi_path: root
                .join("tests/fixtures/mock-pi.mjs")
                .to_string_lossy()
                .into(),
            ..Settings::default()
        };
        let owner = Arc::new(Supervisor::default());
        owner.set_limit(4);
        let mut handles = Vec::new();
        for index in 0..5 {
            let project = if index < 2 { a.path() } else { b.path() };
            let handle = runtime::start(
                &settings,
                project.to_string_lossy().into(),
                tauri::ipc::Channel::new(|_| Ok(())),
            )
            .await
            .unwrap();
            owner.register(handle.clone());
            handles.push(handle);
        }
        let prompt = || Action::Prompt {
            message: "hold:work".into(),
            images: vec![],
            mode: None,
            text_parts: None,
        };
        for (index, handle) in handles.iter().enumerate() {
            owner
                .submit(handle.id.clone(), format!("submit-{index}"), prompt())
                .unwrap();
        }
        let duplicate = owner
            .submit(handles[4].id.clone(), "submit-4".into(), prompt())
            .unwrap();
        assert_eq!(duplicate["desktopTask"], "task-5");
        assert_eq!(
            owner
                .list()
                .iter()
                .filter(|task| task.state == "running")
                .count(),
            4
        );
        assert!(owner.is_queued(&handles[4].id));
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                if handles[0].action(Action::State).await.unwrap()["isStreaming"] == true {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        handles[0].action(Action::Stop).await.unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                if handles[4].action(Action::State).await.unwrap()["isStreaming"] == true {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(
            owner
                .list()
                .iter()
                .filter(|task| task.state == "running")
                .count(),
            4
        );
        owner.pause(true);
        for handle in handles {
            handle.close(true).await.unwrap();
        }
    }
    /// 新草稿排队与取消时均不分配进程，开始时使用预留的同一运行时标识。
    #[tokio::test]
    async fn deferred_session_has_no_process_until_a_slot_is_available() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap();
        let project = tempfile::tempdir().unwrap();
        let settings = Settings {
            pi_path: root
                .join("tests/fixtures/mock-pi.mjs")
                .to_string_lossy()
                .into(),
            ..Settings::default()
        };
        let owner = Arc::new(Supervisor::default());
        owner.set_limit(1);
        let handle = runtime::start(
            &settings,
            project.path().to_string_lossy().into(),
            tauri::ipc::Channel::new(|_| Ok(())),
        )
        .await
        .unwrap();
        owner.register(handle.clone());
        let prompt = || Action::Prompt {
            message: "hold:task".into(),
            images: vec![],
            mode: None,
            text_parts: None,
        };
        owner
            .submit(handle.id.clone(), "first".into(), prompt())
            .unwrap();
        let launch = || Launch {
            settings: settings.clone(),
            project: project.path().to_string_lossy().into(),
            channel: tauri::ipc::Channel::new(|_| Ok(())),
            model: None,
            thinking: None,
        };
        let cancelled = owner
            .submit_new("cancel".into(), prompt(), launch())
            .unwrap();
        assert_eq!(owner.handles().len(), 1);
        owner
            .cancel(cancelled["desktopTask"].as_str().unwrap())
            .unwrap();
        assert_eq!(owner.handles().len(), 1);
        let queued = owner.submit_new("next".into(), prompt(), launch()).unwrap();
        let reserved = queued["runtimeId"].as_str().unwrap().to_string();
        assert!(owner.handle(&reserved).is_err());
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while handle.action(Action::State).await.unwrap()["isStreaming"] != true {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        handle.action(Action::Stop).await.unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                if let Ok(next) = owner.handle(&reserved) {
                    if next.action(Action::State).await.unwrap()["isStreaming"] == true {
                        break;
                    }
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        owner.pause(true);
        for runtime in owner.handles() {
            runtime.close(true).await.unwrap();
        }
    }
    #[test]
    fn cancelled_queue_does_not_consume_capacity() {
        let owner = Arc::new(Supervisor::default());
        owner.pause(true);
        {
            let mut inner = owner.inner.lock().unwrap();
            inner.tasks.insert(
                "a".into(),
                Activity {
                    task_id: "a".into(),
                    runtime_id: "r".into(),
                    state: "queued".into(),
                    position: 1,
                    error: None,
                },
            );
            inner.queue.push_back(Job {
                id: "a".into(),
                runtime: "r".into(),
                action: Action::State,
                launch: None,
            });
        }
        owner.cancel("a").unwrap();
        assert!(owner.inner.lock().unwrap().queue.is_empty());
        assert_eq!(owner.list()[0].state, "cancelled");
    }
}
