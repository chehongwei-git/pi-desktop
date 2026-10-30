# 排错

“未找到 Pi”：先在终端确认 Pi 可独立运行，再到设置执行诊断。Windows npm 用户通常可选择 `%APPDATA%/npm/pi.cmd`，或选择包内 `dist/bundle/cli.js` 并指定 node.exe。运行时版本要符合 Pi 要求。GUI 的 PATH 可能与终端不同，可在额外 PATH 每行补一个目录。

“初始化超时”：检查 Pi 扩展是否需要终端自定义 UI、是否向 stdout 写日志或在启动时阻塞。扩展应把日志写 stderr。基础扩展对话会在初始化阶段显示；自定义 TUI 不支持。初始化失败后可以重连，不会自动提交提示词。

“历史为空”：会话 header.cwd 必须匹配项目实际路径。自定义会话目录在客户端设置后会同时传给 Pi 和历史索引；默认遵循 PI_CODING_AGENT_DIR / PI_CODING_AGENT_SESSION_DIR。无用户消息的空会话不列为历史。旧版迁移由 Pi 完成。

“请求超时”：命令可能已经执行，先检查会话状态，避免重复发送。停止超过 5 秒可强制关闭；当前可见正文与草稿保留。意外退出后可重新连接并打开历史。

“临时容量达到上限”：当前连接的正文/未确认事件总预算为 256MiB。重新连接清理临时副本并按历史恢复；原始 Pi 会话不受影响。磁盘失败明确报错，不静默丢弃协议事件。

应用设置位于系统 Tauri 配置目录 `dev.pi.desktop` 下的 settings.json。诊断日志 desktop.log、desktop.1.log、desktop.2.log 各最多约 2MiB，不包含正文、凭据或完整环境。错误诊断 ID 可与日志关联。损坏配置会备份为 settings.corrupt.json；摘要索引 history-index-v1.json 可删除重建。

Rust 首次编译需要下载依赖。本机曾遇到 crates.io 超时，验证使用命令行临时覆盖到 rsproxy；项目未写入全局 Cargo 镜像配置。企业网络可按自身策略设置 Cargo 镜像。Windows 增量缓存偶发“拒绝访问”时先确保没有并发构建，再清理相关 target 缓存或禁用 CARGO_INCREMENTAL。
