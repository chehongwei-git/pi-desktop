# 排错

“Ctrl+C 退出后再次启动提示 Port 1420 is already in use”：使用 `npm run desktop`，该入口在同一个 Node 进程中运行 Vite 和 Tauri CLI，退出时释放开发端口，避免 npm/shell 层级中的 Vite 子进程残留。正常返回和启动失败还会主动关闭 Vite。回归检查：`node --test scripts/desktop.test.mjs`。直接运行 `npm run tauri -- dev` 仍使用 Tauri 原有的 beforeDevCommand 启动链。

如果旧版启动已留下占用进程，需先结束该残留实例一次；新入口不会自动终止未知的端口占用者。Windows 可在 PowerShell 用 `Get-NetTCPConnection -LocalPort 1420 -State Listen` 查看 OwningProcess，再用 `Get-CimInstance Win32_Process -Filter "ProcessId = <PID>" | Select-Object ProcessId, CommandLine` 确认属于本项目的 Vite，最后执行 `Stop-Process -Id <PID>`。不要批量结束所有 Node 进程。

“未找到 Pi”：先在终端确认 Pi 可独立运行，再到设置执行诊断。Windows npm 用户通常可选择 `%APPDATA%/npm/pi.cmd`，或选择包内 `dist/bundle/cli.js` 并指定 node.exe。运行时版本要符合 Pi 要求。GUI 的 PATH 可能与终端不同，可在额外 PATH 每行补一个目录。

“Pi 无法启动”：从 Finder 等桌面入口启动时不会执行 shell 配置。客户端会在继承 PATH 后补充 Pi 托管安装及运行时、nvm 的版本目录和平台常用安装目录；nvm 后备版本按版本号从高到低排列。设置中的运行时目录优先加入子进程 PATH，额外 PATH 次之，供 Pi 启动脚本及其子进程使用。若 PATH 已有旧 Node，请在设置中指定符合 Pi 要求的 Node，或在额外 PATH 添加其目录；不需要修改全局 PATH。

“初始化超时”：检查 Pi 扩展是否需要终端自定义 UI、是否向 stdout 写日志或在启动时阻塞。扩展应把日志写 stderr。基础扩展对话会在初始化阶段显示；自定义 TUI 不支持。初始化失败后可以重连，不会自动提交提示词。

“历史为空”：会话 header.cwd 必须匹配项目实际路径。自定义会话目录在客户端设置后会同时传给 Pi 和历史索引；默认遵循 PI_CODING_AGENT_DIR / PI_CODING_AGENT_SESSION_DIR。无用户消息的空会话不列为历史。旧版迁移由 Pi 完成。

“请求超时”：命令可能已经执行，先检查会话状态，避免重复发送。停止超过 5 秒可强制关闭；当前可见正文与草稿保留。意外退出后可重新连接并打开历史。

“临时容量达到上限”：当前连接的正文/未确认事件总预算为 256MiB。重新连接清理临时副本并按历史恢复；原始 Pi 会话不受影响。磁盘失败明确报错，不静默丢弃协议事件。

应用设置位于系统 Tauri 配置目录 `dev.pi.desktop` 下的 settings.json。诊断日志 desktop.log、desktop.1.log、desktop.2.log 各最多约 2MiB，不包含正文、凭据或完整环境。错误诊断 ID 可与日志关联。损坏配置会备份为 settings.corrupt.json；摘要索引 history-index-v1.json 可删除重建。

Rust 首次编译需要下载依赖。本机曾遇到 crates.io 超时，验证使用命令行临时覆盖到 rsproxy；项目未写入全局 Cargo 镜像配置。企业网络可按自身策略设置 Cargo 镜像。Windows 增量缓存偶发“拒绝访问”时先确保没有并发构建，再清理相关 target 缓存或禁用 CARGO_INCREMENTAL。
