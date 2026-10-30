# 斜杠命令回归检查

所有可见内置命令都由 `src/lib/command-routing.test.ts` 按菜单动态生成入口测试，禁止误送模型。操作行为分布如下，测试使用隔离 IPC，不调用在线模型、不写用户配置。

| 命令 | 操作测试位置 | 主要断言 |
| --- | --- | --- |
| settings | CommandComposer.test.ts | 自动压缩、两种队列模式、失败保留输入 |
| model | CommandComposer.test.ts、BuiltinCommandDialog.test.ts | 模型选择、5000 项列表有界挂载、IME |
| thinking | CommandComposer.test.ts | 正确调用 set_thinking |
| resume | CommandComposer.test.ts | 通过会话事务恢复 |
| fork | CommandComposer.test.ts | 起点选择、原消息恢复、读取取消和失败 |
| tree | CommandComposer.test.ts、desktop-bridge.test.ts | 导航选项、桥接取消、2000 节点平铺、Esc 退出加载及错误界面、连接失败后返回可编辑 |
| compact | desktop.test.ts、rpc.rs tests | 输入框直接压缩、失败草稿、无 settled 时结束 |
| new | BuiltinCommandDialog.test.ts、desktop.test.ts | 会话创建及取消事务 |
| name | BuiltinCommandDialog.test.ts | 重命名和结果展示 |
| session | BuiltinCommandDialog.test.ts | 统计查询、失败可关闭 |
| clone | BuiltinCommandDialog.test.ts | 成功刷新、取消不刷新、失败可关闭 |
| copy | BuiltinCommandDialog.test.ts | 权威文本写剪贴板、失败可关闭 |
| export | BuiltinCommandDialog.test.ts | 显式执行 HTML 导出 |
| reload | BuiltinCommandDialog.test.ts、desktop-bridge.test.ts | 不重连、模型新配置应用、旧 ctx 不复用、失败展示 |
| quit | BuiltinCommandDialog.test.ts、runtime.rs tests | 断开入口及子进程回收 |

扩展、模板和技能验证通用 prompt 分发；不能据此声称任意第三方扩展业务兼容。

运行前端检查：`npm run check` 和 `npx vitest run`。Rust 检查：`cargo test --manifest-path src-tauri/Cargo.toml`。真实 Pi 桥接冒烟：`python3 scripts/verify-bridge.py`，不发起模型请求。浏览器回归位于 `tests/browser/desktop.spec.ts`，覆盖命令分类、设置层级、树加载未完成及失败后 Esc、恢复输入并继续发送；使用 `npx playwright test -g 'tree Esc|fatal tree|slash commands|settings use native'`，需要对应 Chromium 或在本机测试配置选择已安装 Chrome。

人工验收：输入 `/tree`，加载期间按 Esc；再次输入 `/tree`，在列表或错误提示中按 Esc；也通过 Tab 聚焦返回按钮再按 Esc。每次应回到消息输入框，能够编辑、选择其他命令、发送普通消息。读取结果迟到时不得重新打开菜单或覆盖输入。真正执行导航期间不会把 Esc 当作取消已发送的变更。协议失败同时导致连接失败时，点击返回后仍可编辑草稿，发送需先重新连接。`rpc.rs` 用旧版嵌套树复现解析深度错误，并验证 2000 条平铺记录不触发此问题；`/tree` 通过 `get_entries` 获取平铺记录，宿主只传节点摘要。
