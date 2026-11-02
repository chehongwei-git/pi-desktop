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
#[derive(Default)]
struct Inner {
    handles: HashMap<String, runtime::Handle>,
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
}
impl Supervisor {
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
        inner.handles.remove(id)
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
                if self.inner.lock().unwrap().launching.is_empty() {
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
        let handle = runtime::start_reserved(
            &launch.settings,
            launch.project.clone(),
            launch.channel.clone(),
            Some(runtime.into()),
        )
        .await?;
        self.register(handle.clone());
        if self.inner.lock().unwrap().closing {
            let _ = handle.close(true).await;
            self.remove(runtime);
            return Err(AppError::new("CLOSING", "应用正在退出"));
        }
        let init = tokio::time::timeout(std::time::Duration::from_secs(30), async {
            if let Some((provider, model)) = launch.model {
                handle.action(Action::SetModel { provider, model }).await?;
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
