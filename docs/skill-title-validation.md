# Skill 会话自动摘要验证

## 规则与实现

- 完整标准 Skill 消息优先取闭合包装之后的用户任务，只有技能时显示“使用 技能名”；不将指令和路径放进自动标题。
- 自动摘要合并空白，最多 100 个 Unicode 码点；先提取再截断。引用和代码示例不解析。
- Rust 摘要复用 `text_presentation::skill`，前端 `sessionPreview` 用于草稿、提交与恢复。旧截断恢复摘要无法还原任务时仅回退技能名。
- 历史索引升级至 `history-index-v3.json`，不读旧 v2 索引，从原始会话只读重建。原 JSONL、手动名称、时间与排序不变。
- 侧栏及搜索消费统一摘要；保留原有历史显式名称、桌面别名和占位名称优先级，不让 Pi 的“新会话”占位遮住历史任务摘要。

## 最终版本验证（macOS）

| 命令 | 结果 |
| --- | --- |
| `npm run check` | 0 错误、0 警告 |
| `npm test` | 58 文件、422 通过，0 失败 |
| `node --test scripts/desktop.test.mjs` | 3 通过，0 失败、0 跳过 |
| `CI=1 npm run test:browser` | 113 通过，0 失败 |
| `npm run build` | 通过，主包超过 500 kB 的既有警告保留 |
| `npx prettier --check src tests '*.ts' '*.js' '*.json' 'src-tauri/*.json' 'src-tauri/capabilities/*.json'` | 通过 |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --check` | 通过 |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings` | 通过 |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked` | 89 通过、0 失败、1 既有忽略 |
| `git diff --check` | 通过 |

新增覆盖中文任务、长技能指令、无任务回退、Windows/POSIX 路径、LF/CRLF、Unicode 截断、旧截断摘要、旧 v2 有效缓存重建、v3 重启读取、搜索、JSONL 不变、显式名称、本地草稿与首次发送到索引刷新。浏览器使用真实 SidebarSession，检查任务名、技能回退、手动名称、完整悬停、无障碍名称和键盘焦点；宽屏浅色与窄屏深色截图为 `test-results/skill-title-*.png`，已查看窄屏深色实际渲染。

首次全量测试发现调整名称优先级导致“新会话”占位覆盖历史摘要，已恢复原优先级并保留原测试，最终重新执行完整清单通过，未弱化断言或增加跳过。

## 待验证范围

Rust 原有 `platform::tests::installed_pi_starts_with_gui_path` 仍忽略（需要安装 Pi 并以最小 PATH 单独执行）；本轮未将其计为通过。Windows、Linux CI、三平台原生打包和 WebView 实机未执行；浏览器模拟 IPC 不代替真实 Pi 技能扩展集成。整体为本机实现通过、待原生／跨平台验收，不宣称三平台已验证。
