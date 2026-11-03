# 架构与维护

依赖从组件向业务门面、IPC 端口、Rust 应用服务再到 RPC/平台边界流动。没有本地业务 HTTP 服务；Vite 仅在开发时提供前端资源，发行版加载打包静态文件。

```text
App.svelte / components
  → Workspace（跨项目导航、活动摘要）→ Desktop（独立会话状态）→ client.ts（可替换 IPC）
  → lib.rs（生命周期与会话身份、白名单 commands）→ supervisor.rs（全应用 FIFO 调度）
  → runtime.rs（每个会话独立 actor / stdin / pending 请求）
  → platform.rs / rpc.rs / storage.rs
```

`history.rs` 只读 Pi 历史，`settings.rs` 原子保存应用偏好，`diagnostics.rs` 写结构化诊断。Rust DTO 与 `src/lib/types.ts` 成对维护。新增业务应扩展 `Action` 与明确的类型，不暴露任意 RPC、文件访问或 shell 接口。

模型配置通过独立 get_model_config/save_model_config/discover_models 业务接口进入 model_config.rs/model_discovery.rs，不扩充普通 Settings 的凭据字段。共享仓库仅向前端投影白名单字段，未知模型参数及认证请求头在宿主合并保留。文件版本使用 SHA-256，保存前获取与 Pi proper-lockfile 相同的 .lock 目录并校验版本；不持锁执行网络请求。单文件用同目录 tempfile 原子替换，多文件失败尝试恢复，无法保证进程被强杀时的多文件事务性。auth.json 保留既有权限，新建凭据文件使用私有临时文件权限，Windows 继承目录 ACL，仍需 Windows 实机权限验收。配置文件目前要求标准 JSON（兼容 BOM），含注释的 models.json 会拒绝编辑且保留原文。

模型发现使用 reqwest + rustls，不依赖系统 shell 或 WebView CORS。限定三种协议的 GET /models，禁止重定向，限制超时、响应大小、分页数和模型数量。错误不包含远端正文、URL 参数或密钥；UI 取消等待以请求代次隔离，网络 Future 在宿主超时后释放。配置应用通过 refresh_models Action 复用现有 pi-desktop-models-v1 桥接，前端集中管理 pending/applying/status；默认启动设置明确提示重新连接读取。

actor 独占 stdin、请求表、投影和临时存储。stdout 与 stderr 各自有读取任务；stdout 通过有界通道交给 actor。请求 ID 关联响应，超时不重发。事件按序落盘，Channel 只通知拉取，前端处理成功后返回 ack。只有相邻同消息/同字段的 delta 合并，生命周期与最终消息保持原顺序。`message_end` 覆盖流式内容，`agent_settled` 发布 idle；prompt 响应不能代表任务完成。

跨项目和同项目的不同会话各自持有 Pi 实例，Workspace 只切换前台对象，后台 Desktop 持续消费自己的 Channel、ack 和正文事件。侧栏以独立稳定 desktopId 合并磁盘历史与本机未落盘草稿；文件路径是可选字段，绑定历史时沿用原身份并按规范路径别名去重。旧版恢复数据缺少 desktopId 时启动生成并在下次写入升级，不修改 Pi JSONL。运行、完成、失败等轻量状态从会话行展示，状态更新不改变活动排序；打开后台完成项清除未读标记但保留完成状态。会话文件在宿主按规范路径去重；runtimeId 与每会话 generation 隔离重启前的迟到数据。打开已有会话通过 connect_pi 的 sessionPath 恢复，定向 disconnect_pi 只回收指定实例。

supervisor.rs 用短暂互斥锁保护运行时注册表、提交去重表和全应用 FIFO 队列，锁外执行初始化、RPC 和退出。并发默认 4、可配 1–16；最多 100 条等待项，每个会话最多一条等待初始任务。等待扩展回答、重试和压缩仍占名额。actor 的 watch 生命周期和 settled 计数直接通知调度器，不依赖前端是否拉取事件；settled 后再查询 Pi 是否空闲且无待处理消息，prompt 回执不能释放名额。停止、查询和扩展响应不进入队列；引导和 followUp 沿用当前名额。

新草稿首次发送通过 submit_new_task 预留 taskId/runtimeId、模型强度和附件快照，领取名额后才创建进程；普通已打开会话通过 perform 的 submissionId 准入。get_submission 用于丢失 IPC 响应后的只读确认，不自动重发。list_activity 每 500ms 返回轻量状态快照，正文仍走各运行时原有的可靠批次接口，不额外广播逐 token 内容。

退出请求先通知当前界面显示确认条，确认后暂停调度并回收所有实例；启动中的实例同样纳入关闭等待。Windows Job / Unix 独立进程组限定各自子树，显式 drop stdin 让子进程观察 EOF。强制退出入口可越过正常退出等待的生命周期锁。

历史索引只缓存 cwd、标题、摘要、mtime、大小与读取偏移，不保存永久正文。追加只读完整尾行；截断或同大小修改重建。当前分支通过 get_entries 的 leafId 父链恢复，前端每页接收 50 条。临时存储包含正文引用与待确认事件，上限 256MiB；超限或 IO 失败显式报错。正常关闭删除临时文件。

正文每条预览最多 64KiB；每会话可重载文本预算 8MiB，全应用每五秒检查 32MiB 预算，已挂载正文和流式内容除外。使用普通文档流，跨项目保留最近十二个已加载会话的内容和最近六个对话 DOM，两层独立按访问顺序淘汰；空白本地草稿不占内容额度。仅当前会话保留空闲进程，后台空闲进程在轮询时释放，但保留缓存内容和视图。运行、排队、提交、连接恢复、历史加载及等待扩展交互的会话不回收；受保护内容可暂时超出额度。回收前确认事件，返回时先显示缓存并后台连接，在暂存区恢复已读窗口后一次提交，提交前捕获最新阅读锚点。SessionContent 将正文、工具参数、写入、差异和图片引用封装为带运行时所有权的句柄；历史恢复时只为匹配内容重新绑定句柄，避免进程内 body-N 重用造成串读。新运行时启动 reset 先消费而不清空旧视图，迟到读取不能覆盖新状态；隐藏视图的未完成读取等待激活，不启动进程。内容淘汰释放正文与派生引用，保留草稿、展开偏好与阅读恢复信息。若点击发生在原生关闭尚未完成期间，按会话等待回收任务结束再连接，防止旧实例仍持有文件身份时重复打开。`Workspace.open(path)` 优先复用已有 Desktop 实例（按 `snapshot.sessionFile` 匹配），避免重复连接同一会话触发后端 SESSION_OPEN 错误；复用时更新 `project` 确保工作目录正确。思考、图片、挂载 DOM 与各运行时临时存储不纳入这一正文预算，不能承诺总内存恒定。

Workspace 将未发送文字、执行中或排队输入及恢复标记版本化写入本机 localStorage，单键原子替换；记录携带稳定 desktopId、创建时间、最近发送时间和首次输入摘要，使无文件草稿及中断条目可从原会话列表恢复。已提交历史与本地条目按路径规范化去重，不为虚拟条目合成文件路径。图片和临时正文引用不持久保存。重启只恢复为可编辑内容和中断提示，不恢复执行。存储失败在页内反馈。Markdown 禁止原始 HTML、远程图片与嵌入页面；只有 http/https 交给系统浏览器。

所有手写源码使用中文注释说明职责、输入输出、异步所有权和副作用。公共类型与复杂状态不变量必须同步注释；避免逐行复述赋值。JSON 配置没有注释能力，其关键决策在文档说明。执行 `npm run format` 与 `cargo fmt`，检查 TypeScript strict、Svelte、Vitest、浏览器集成、clippy 与 Rust 测试。平台相关修改同时检查条件编译分支。

图标源为 `assets/icon.svg`；`npm run tauri -- icon assets/icon.svg` 可重建平台图标。Tauri 配置中只授权目录选择和 http/https opener。开发 CSP 单独允许 Vite WebSocket，发行 CSP 不包含开发地址。
