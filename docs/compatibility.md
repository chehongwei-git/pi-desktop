# RPC 与平台兼容

协议参考本机 Pi 1.4.0。其他版本显示未经验证提示；连接握手要求 `get_state` 与 `get_entries` 可用，否则清理子进程并报错。客户端不包含 Pi npm 运行依赖。

| 能力 | 命令 / 事件 | 行为 |
| --- | --- | --- |
| 发送与停止 | prompt、clear_queue、abort | 请求 ID 关联，不自动重发；停止恢复清队列文本 |
| 会话 | new_session、switch_session、set_session_name | 尊重扩展 cancelled，Pi 为唯一写入方 |
| 历史 | get_entries、leafId/parentId | 原始当前分支，包含压缩摘要，不改写 context_edit |
| 模型 | get_available_models、set_model | 与 Pi 的配置和凭据共用 |
| 思考 | get_available_thinking_levels、set_thinking_level | 切模型后重查 |
| 命令 | get_commands + 桌面内置命令 | 公开内置命令本地识别；模板/技能/扩展交给 Pi，隐藏桌面桥接内部命令 |
| Pi 设置 | set_auto_compaction、set_steering_mode、set_follow_up_mode | 输入框内联二级菜单；不等同完整终端设置 |
| 热重载 | RPC prompt + 显式加载的 desktop.mjs 扩展 | 资源重载后用新上下文刷新本地模型配置、重新应用当前模型；不重启进程 |
| 树导航 | get_entries 平铺摘要 + 桥接 ctx.navigateTree | 避免深层树 JSON 解析超限；内联选择节点，再选择直接导航或生成摘要后导航；尊重扩展取消 |
| 流式 | message_start/update/end、agent_settled | 最终正文权威覆盖；settled 才结束运行 |
| 工具 | tool_execution_start/update/end、toolResult | 以 toolCallId 合并，partial 替换预览 |
| 扩展对话 | select、confirm、input、editor | 取消、超时、一次性回应 |
| 扩展通知 | notify、setStatus、setWidget、setTitle、set_editor_text | 字符串 widget，填充保留已有草稿 |

桥接源码编入 Rust 产物，启动时写入私有临时目录，并通过 `pi --extension` 加载；进程退出后删除。只运行现有 Pi，不附带或另起 Node/Bun/SDK 宿主、不监听端口、不改用户全局扩展配置。内部命令执行前检查注册，关联 RPC disposition 与 extension_error 判断结果，超时不重发。Pi 本身的安装要求仍由其发行方式决定。

`/settings`、`/model`、`/thinking`、`/resume`、`/fork`、`/tree` 采用输入框内联菜单；其余可执行命令采用桌面原生弹层。内联菜单搜索本地执行，最多挂载 40 条候选，支持键盘与“更多选项”浏览。`/settings` 与侧栏桌面连接设置分开，目前只包含自动压缩和两种排队模式。完整设置、scoped-models、import、share、bug、trust、login、logout、changelog 仍未适配；HTML 导出已支持，JSONL 导出未支持。树导航支持直接切换和生成摘要后切换，摘要可能调用模型并产生费用；尚未实现完整终端树标签编辑。未适配的 8 个内置命令不出现在斜杠菜单，hotkeys 也按产品要求隐藏；导出分类仅显示 export。桥接命令未注册时隐藏对应 reload/tree 菜单项。

桥接重载比单独 ctx.reload 多出显式本地模型刷新。配置错误、提供商刷新错误、当前模型被删或认证失败均报错；不自动选择其他模型。未承诺模型请求实际地址的网络验收，当前验证不调用付费模型。

验证：55 项前端单元测试、16 项 Rust 测试、类型检查及生产构建通过。使用本机 Chrome 跑通两项浏览器验收：可执行命令分类及明暗主题、设置二级菜单及窗口边界。隔离配置的真实 Pi RPC 冒烟验证桥接加载、热重载后命令保留、模型刷新及会话不变。5,000 模型候选测试确认菜单 DOM 不超过 40 项；尚未完成跨平台实机、端到端延迟分位数及付费模型请求验收。默认 Rust 工具链缺少 Clippy，现有另一套 stable 工具链版本低于依赖要求，因此 Clippy 未完成。

TUI custom 组件、任意终端 UI 与交互式终端命令无法原样呈现。客户端没有内置终端；扩展仍在 Pi 进程内拥有原有工具能力，桌面权限配置不构成 Agent 沙箱。

Windows 使用 npm 布局解析 Node+JS 或直接原生 exe，不执行未知 cmd/ps1。Unix 使用可执行入口、shebang 或显式运行时+JS。额外 PATH 仅对子进程生效，不加载登录 shell。

Windows x64 NSIS 为优先交付目标，缺少 WebView2 时联网引导。macOS unsigned app、Linux deb 先作为 CI 验证产物，仍待各平台实机验收；没有签名、公证或自动更新支持。
