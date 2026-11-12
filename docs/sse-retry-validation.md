# SSE JSON 响应读取失败自动重试验证

## 行为与范围

桌面桥接识别助手的 `malformed server-sent event JSON` 错误，最多额外恢复 3 次，退避 2、4、8 秒。通过 `turn_end` 等待并修复上下文投影，再由 `agent_before_settle` 请求继续，兼容 Pi 对错误响应的硬退出规则。使用当前 turn 的 AbortSignal 取消等待，关闭扩展时释放计时器和监听器。

原始失败及部分正文保留在历史中，恢复时仅省略失败助手的模型上下文投影，不重新插入用户消息或主动重放工具。状态沿用现有重试提示及停止入口；停止覆盖此前失败尝试的临时任务标记。重试配置不落盘，CLI 及其他错误策略不变。

## 自动化覆盖

- `src/lib/desktop-retry.test.ts`：14 项，覆盖 2/4/8 秒退避、次数上限、错误匹配与排除、取消、关闭、会话隔离、投影编辑、已有队列或继续行为、成功后重置。
- Rust RPC 测试：重试状态不提前发布 idle，不把内部 JSON 展示给用户。
- Rust actor 测试：错误后的重试等待保持 Busy，停止后最终为 Idle 且清除临时失败标记。
- `tests/browser/desktop.spec.ts`：宽屏浅色及窄屏深色下验证重试反馈、停止、草稿与焦点保留、无弹窗及状态清理；截图人工检查无拥挤或截断。

以上测试均加入现有 Vitest、Cargo 或 Playwright 套件，沿用现有 CI 命令，无新增独立套件。

## 最终版本本机验证

平台：Windows；浏览器使用项目配置的系统 Edge。下表记录最终代码版本的完整检查，各命令均以退出码 0 结束。

| 命令 | 结果 |
| --- | --- |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --check` | 通过 |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings` | 通过 |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked` | 81 通过、0 失败、1 原有忽略；二进制及文档测试均无用例 |
| `npm run check` | 通过，0 错误、0 警告 |
| `npm test -- --maxWorkers=2 --minWorkers=1` | 398 通过、0 失败、0 忽略（54 个测试文件） |
| `node --test scripts/desktop.test.mjs` | 3 通过、0 失败、0 忽略 |
| `npm run test:browser -- --workers=1` | 109 通过、0 失败、0 忽略 |
| `npm run build` | 通过 |
| `npx prettier --check src tests "*.ts" "*.js" "*.json" "src-tauri/*.json" "src-tauri/capabilities/*.json" src-tauri/bridge/desktop.mjs` | 通过 |
| `git diff --check` | 通过 |

原有忽略用例 `platform::tests::installed_pi_starts_with_gui_path` 已额外执行：直接运行本轮 Cargo 生成的测试二进制，参数为 `--ignored --exact platform::tests::installed_pi_starts_with_gui_path`，仅对子进程将 PATH 设为 Windows System32。结果 1 通过、0 失败、0 忽略；未更改仓库中的 ignore 标记或系统环境。

## 真实 Pi 额外验证

在临时目录中隔离 `PI_CODING_AGENT_DIR`，禁用原生自动重试，加载真实桌面桥接与无网络的测试供应商，经真实 Pi RPC 运行以下场景，全部通过：

1. 连续 3 次目标错误后第 4 次请求成功：4 次请求、4 条助手记录。
2. 连续目标错误耗尽：总计 4 次请求，最后错误保留原文并附重试次数。
3. 第一次退避期间发送 abort：仅 1 次请求，最终 `agent_settled.aborted=true`，没有迟到恢复。
4. 第一次恢复请求已经开始后发送 abort：总计 2 次请求，最终取消，没有继续尝试后续恢复。

逐次核对模型上下文均仅有 1 条用户消息，失败助手记录未进入后续请求。该验证使用合成供应商响应验证真实 Pi 生命周期，不调用外部模型，也不等同于远端 SSE 服务联调或原生桌面验收。

## 排查记录与验证边界

- 首轮 `npm test` 与 Rust 编译并行执行时，既有模型选择组件的 500 条目录用例触发 5 秒超时，397 通过、1 失败。最终检查改为串行执行各套命令，并将 Vitest 限制为 2 个 worker；原超时与断言保持不变。最终轮该用例耗时约 606ms。
- 中间一轮新增 Rust 测试使用 `assert_eq!` 比较未实现 Debug 的枚举，编译失败；已改为等效的 `matches!` 断言，并在最终版本重新执行完整检查。
- 并行浏览器检查中，既有 28 万字节长文本的重启恢复用例在 5 秒断言期限内仅展示部分分页正文，108 通过、1 失败。最终检查按仓库 CI 的资源隔离方式使用单 worker，保留原超时和完整正文断言，整套 109 项通过。
- 未增加 skip/ignore、降低断言要求或放宽测试超时；较早轮次的通过结果不代替最终版本全量结果。
- macOS、Linux 的 CI、三平台原生打包与原生 WebView 验收尚未执行，发布前仍待验证；不宣称已完成三平台发布验证或 WCAG 审核。
