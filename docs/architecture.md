# 架构与维护

依赖从组件向业务门面、IPC 端口、Rust 应用服务再到 RPC/平台边界流动。没有本地业务 HTTP 服务；Vite 仅在开发时提供前端资源，发行版加载打包静态文件。

```text
App.svelte / components
  → Desktop（响应式状态与切换事务）→ client.ts（可替换 IPC）
  → lib.rs（生命周期锁、白名单 commands）
  → runtime.rs（单 actor / stdin / pending 请求）
  → platform.rs / rpc.rs / storage.rs
```

`history.rs` 只读 Pi 历史，`settings.rs` 原子保存应用偏好，`diagnostics.rs` 写结构化诊断。Rust DTO 与 `src/lib/types.ts` 成对维护。新增业务应扩展 `Action` 与明确的类型，不暴露任意 RPC、文件访问或 shell 接口。

模型配置通过独立 get_model_config/save_model_config/discover_models 业务接口进入 model_config.rs/model_discovery.rs，不扩充普通 Settings 的凭据字段。共享仓库仅向前端投影白名单字段，未知模型参数及认证请求头在宿主合并保留。文件版本使用 SHA-256，保存前获取与 Pi proper-lockfile 相同的 .lock 目录并校验版本；不持锁执行网络请求。单文件用同目录 tempfile 原子替换，多文件失败尝试恢复，无法保证进程被强杀时的多文件事务性。auth.json 保留既有权限，新建凭据文件使用私有临时文件权限，Windows 继承目录 ACL，仍需 Windows 实机权限验收。配置文件目前要求标准 JSON（兼容 BOM），含注释的 models.json 会拒绝编辑且保留原文。

模型发现使用 reqwest + rustls，不依赖系统 shell 或 WebView CORS。限定三种协议的 GET /models，禁止重定向，限制超时、响应大小、分页数和模型数量。错误不包含远端正文、URL 参数或密钥；UI 取消等待以请求代次隔离，网络 Future 在宿主超时后释放。配置应用通过 refresh_models Action 复用现有 pi-desktop-models-v1 桥接，前端集中管理 pending/applying/status；默认启动设置明确提示重新连接读取。

actor 独占 stdin、请求表、投影和临时存储。stdout 与 stderr 各自有读取任务；stdout 通过有界通道交给 actor。请求 ID 关联响应，超时不重发。事件按序落盘，Channel 只通知拉取，前端处理成功后返回 ack。只有相邻同消息/同字段的 delta 合并，生命周期与最终消息保持原顺序。`message_end` 覆盖流式内容，`agent_settled` 发布 idle；prompt 响应不能代表任务完成。

连接和断开通过异步生命周期锁串行，业务请求克隆句柄后释放锁。窗口退出等待 stdin 关闭和子进程回收，Windows Job / Unix 独立进程组限定自有子树。必须显式 drop stdin 才保证子进程观察 EOF。每个连接的 runtimeId 和前端 generation 用于隔离迟到数据。

历史索引只缓存 cwd、标题、摘要、mtime、大小与读取偏移，不保存永久正文。追加只读完整尾行；截断或同大小修改重建。当前分支通过 get_entries 的 leafId 父链恢复，前端每页接收 50 条。临时存储包含正文引用与待确认事件，上限 256MiB；超限或 IO 失败显式报错。正常关闭删除临时文件。

正文每条预览最多 64KiB；前端按 LRU 淘汰可重载文本，预算 8MiB，虚拟列表挂载窗口与流式内容除外。思考预览目前保留在内存，因此思考密集的超长历史仍可能超过预算；验证记录明确保留该限制。虚拟列表只挂载可见项与少量 overscan。Markdown 禁止原始 HTML、远程图片与嵌入页面；只有 http/https 交给系统浏览器。

所有手写源码使用中文注释说明职责、输入输出、异步所有权和副作用。公共类型与复杂状态不变量必须同步注释；避免逐行复述赋值。JSON 配置没有注释能力，其关键决策在文档说明。执行 `npm run format` 与 `cargo fmt`，检查 TypeScript strict、Svelte、Vitest、浏览器集成、clippy 与 Rust 测试。平台相关修改同时检查条件编译分支。

图标源为 `assets/icon.svg`；`npm run tauri -- icon assets/icon.svg` 可重建平台图标。Tauri 配置中只授权目录选择和 http/https opener。开发 CSP 单独允许 Vite WebSocket，发行 CSP 不包含开发地址。
