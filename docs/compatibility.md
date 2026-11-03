# RPC 与平台兼容

协议最初参考 Pi 1.4.0。版本基线仅用于设置页主动检测的诊断信息；连接成功不因版本差异显示全局提示，后续升级 Pi 同样适用。连接握手要求 `get_state` 与 `get_entries` 可用，否则清理子进程并显示具体错误。客户端不包含 Pi npm 运行依赖。

| 能力 | 命令 / 事件 | 行为 |
| --- | --- | --- |
| 发送与停止 | prompt（含 images）、clear_queue、abort | 支持图片、steer/followUp；请求 ID 关联，不自动重发；停止结合本地记录恢复排队附件 |
| 会话 | new_session、switch_session、set_session_name | 尊重扩展 cancelled，Pi 为唯一写入方 |
| 历史 | get_entries、leafId/parentId | 原始当前分支，包含压缩摘要，不改写 context_edit |
| 模型 | get_available_models、set_model、桌面共享配置仓库、模型发现 | 与 Pi 配置和凭据共用；支持参数、思考映射及默认值编辑，三种协议远端模型发现 |
| 思考 | get_available_thinking_levels、set_thinking_level | 切模型后重查 |
| 命令 | get_commands + 桌面内置命令 | 公开内置命令本地识别；模板/技能/扩展交给 Pi，隐藏桌面桥接内部命令 |
| Pi 设置 | set_auto_compaction、set_steering_mode、set_follow_up_mode | 输入框内联二级菜单；不等同完整终端设置 |
| 热重载 | RPC prompt + 显式加载的 desktop.mjs 扩展 | 资源重载后用新上下文刷新本地模型配置、重新应用当前模型；不重启进程 |
| 树导航 | get_entries 平铺摘要 + 桥接 ctx.navigateTree | 避免深层树 JSON 解析超限；内联选择节点，再选择直接导航或生成摘要后导航；尊重扩展取消 |
| 流式 | message_start/update/end、agent_settled | 最终正文权威覆盖；settled 才结束运行 |
| 工具 | tool_execution_start/update/end、toolResult | 以 toolCallId 合并，partial 替换预览 |
| 扩展对话 | select、confirm、input、editor | 取消、超时、一次性回应 |
| 扩展通知 | notify、setStatus、setWidget、setTitle、set_editor_text | 字符串 widget，填充保留已有草稿 |

桥接源码编入 Rust 产物，启动时写入私有临时目录，并通过 `pi --extension` 加载；进程退出后删除。只运行现有 Pi，不附带或另起 Node/Bun/SDK 宿主、不监听端口、不改用户全局扩展配置。内部命令执行前检查注册，关联 RPC disposition 与 extension_error 判断结果，超时不重发。Pi 本身的安装要求仍由其发行方式决定。项目不附带需安装到 Pi agent 目录的配套扩展，不自动安装、复制、更新或覆盖用户扩展文件，不修改 Pi 安装源码。用户已有扩展的命令、交互和计划卡片继续兼容；桥接和模型配置冒烟在临时 agent 目录中运行，不操作真实用户扩展目录。

`/settings`、`/model`、`/thinking`、`/resume`、`/fork`、`/tree` 采用输入框内联菜单；其余可执行命令采用桌面原生弹层。内联菜单搜索本地执行，最多挂载 40 条候选，支持键盘与“更多选项”浏览。`/settings` 与侧栏桌面连接设置分开，目前只包含自动压缩和两种排队模式。完整终端设置、scoped-models、import、share、bug、trust、login、logout、changelog 仍未适配；设置页已提供独立 API Key 管理，OAuth login/logout 命令仍未适配；HTML 导出已支持，JSONL 导出未支持。树导航支持直接切换和生成摘要后切换，摘要可能调用模型并产生费用；尚未实现完整终端树标签编辑。未适配的 8 个内置命令不出现在斜杠菜单，hotkeys 也按产品要求隐藏；导出分类仅显示 export。桥接命令未注册时隐藏对应 reload/tree 菜单项。

桥接重载比单独 ctx.reload 多出显式本地模型刷新。配置错误、提供商刷新错误、当前模型被删或认证失败均报错；不自动选择其他模型。未承诺模型请求实际地址的网络验收，当前验证不调用付费模型。

验证：55 项前端单元测试、16 项 Rust 测试、类型检查及生产构建通过。使用本机 Chrome 跑通两项浏览器验收：可执行命令分类及明暗主题、设置二级菜单及窗口边界。隔离配置的真实 Pi RPC 冒烟验证桥接加载、热重载后命令保留、模型刷新及会话不变。5,000 模型候选测试确认菜单 DOM 不超过 40 项；尚未完成跨平台实机、端到端延迟分位数及付费模型请求验收。默认 Rust 工具链缺少 Clippy，现有另一套 stable 工具链版本低于依赖要求，因此 Clippy 未完成。

模型配置首版支持 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages；已有其他协议保留，但不支持新增或切换为其他协议。模型发现要求显式地址和协议；自动环境认证仅内置 openai/anthropic/openrouter/deepseek 有默认变量回退，其他服务商应显式选择环境引用。已有额外认证头保留给 Pi，但发现接口暂不执行额外头配置，因而部分服务需手动添加模型。JSON 注释配置保持原文并拒绝编辑。内置模型覆盖候选来自当前可用目录，未认证模型无法离线枚举；可先保存认证并刷新后添加覆盖。默认启动设置热更新未承诺，需重新连接确保读取。

TUI custom 组件、任意终端 UI 与交互式终端命令无法原样呈现。客户端没有内置终端；扩展仍在 Pi 进程内拥有原有工具能力，桌面权限配置不构成 Agent 沙箱。

Windows 使用 npm 布局解析 Node+JS 或直接原生 exe，不执行未知 cmd/ps1。Unix 使用可执行入口、shebang 或显式运行时+JS。额外 PATH 仅对子进程生效，不加载登录 shell。

## Pi 1.5.0 核对

依据本机安装包的 CHANGELOG 与 RPC 文档核对，未发现本版新增的必需 RPC 协议迁移。Windows 下用隔离配置执行 `scripts/verify-process-pool.mjs` 已通过真实进程验证：状态读取、跨项目会话切换、相对路径、桥接命令重新加载和同项目新建。该验证不调用模型，不代表付费请求及第三方扩展已全部验收；macOS/Linux 尚未实机验证。

| 1.5.0 变化 | 桌面影响与适配结论 |
| --- | --- |
| GPT-6.1 Terra、模型目录更新、thinking off | 现有模型列表从 Pi 动态读取，无需硬编码新模型；已有关闭思考入口。实际服务商请求仍需单独验收 |
| 工具参数校验改为 pi-schema | 桌面桥接只注册命令，不定义 TypeBox 工具参数，未直接受影响；第三方扩展使用 Refine、BigInt、Undefined、codecs 或自定义 Format 时需迁移到 JSON Schema 可表达的规则 |
| 大工具参数增量解析、TUI 渲染缓存 | Pi 的解析优化随升级生效；TUI 渲染优化不会自动优化桌面的 Svelte/Markdown 渲染 |
| responseModel、cost.totalFromProvider | 可选增强：展示实际响应模型及费用来源。当前桌面消息投影未展示这两项，不影响现有 RPC 连接 |
| 扩展更新日志、collapseChangelog | 桌面暂无扩展更新日志专用入口，可按产品需求补充 |
| custom UI 的 blocked 选项 | RPC 的 custom() 仍返回 undefined，不能直接映射到桌面等待交互；扩展应使用 RPC 支持的 select/confirm/input/editor |
| 自定义更新命令、设备码登录、MCP OAuth 改进 | 由 Pi CLI 或运行时处理；桌面暂无自更新与 OAuth 登录专用流程 |
| pi.exec 的 maxBuffer/truncated、进程终止和 UTF-8 修复 | 当前桌面桥接不调用 pi.exec，无需迁移；使用该 API 的第三方扩展可利用截断标志 |

Windows x64 NSIS 为优先交付目标，缺少 WebView2 时联网引导。macOS unsigned app、Linux deb 先作为 CI 验证产物，仍待各平台实机验收；没有签名、公证或自动更新支持。
