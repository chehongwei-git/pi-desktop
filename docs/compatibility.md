# RPC 与平台兼容

协议参考本机 Pi 1.4.0。其他版本显示未经验证提示；连接握手要求 `get_state` 与 `get_entries` 可用，否则清理子进程并报错。客户端不包含 Pi npm 运行依赖。

| 能力 | 命令 / 事件 | 行为 |
| --- | --- | --- |
| 发送与停止 | prompt、clear_queue、abort | 请求 ID 关联，不自动重发；停止恢复清队列文本 |
| 会话 | new_session、switch_session、set_session_name | 尊重扩展 cancelled，Pi 为唯一写入方 |
| 历史 | get_entries、leafId/parentId | 原始当前分支，包含压缩摘要，不改写 context_edit |
| 模型 | get_available_models、set_model | 与 Pi 的配置和凭据共用 |
| 思考 | get_available_thinking_levels、set_thinking_level | 切模型后重查 |
| 命令 | get_commands | 只显示返回的技能/模板/扩展命令 |
| 流式 | message_start/update/end、agent_settled | 最终正文权威覆盖；settled 才结束运行 |
| 工具 | tool_execution_start/update/end、toolResult | 以 toolCallId 合并，partial 替换预览 |
| 扩展对话 | select、confirm、input、editor | 取消、超时、一次性回应 |
| 扩展通知 | notify、setStatus、setWidget、setTitle、set_editor_text | 字符串 widget，填充保留已有草稿 |

TUI custom 组件、任意终端 UI 与交互式终端命令无法原样呈现。客户端没有内置终端；扩展仍在 Pi 进程内拥有原有工具能力，桌面权限配置不构成 Agent 沙箱。

Windows 使用 npm 布局解析 Node+JS 或直接原生 exe，不执行未知 cmd/ps1。Unix 使用可执行入口、shebang 或显式运行时+JS。额外 PATH 仅对子进程生效，不加载登录 shell。

Windows x64 NSIS 为优先交付目标，缺少 WebView2 时联网引导。macOS unsigned app、Linux deb 先作为 CI 验证产物，仍待各平台实机验收；没有签名、公证或自动更新支持。
