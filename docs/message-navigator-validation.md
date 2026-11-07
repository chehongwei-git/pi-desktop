# 我的消息目录验证记录

## 实现范围

- 对话右侧 36px 书签栏、页内目录、当前阅读条目标记及摘要筛选。
- 当前会话已确认用户消息；独立目录分页与正文按需补载。
- 定位暂停跟随、目标焦点及短暂强调；取消不撤销已读取的历史页。
- 窄对话区目录铺满正文可用宽度，成功定位后收起；不修改原消息或输入草稿。
- 会话视图保留期间保留目录状态，视图淘汰后重新建立；不新增持久化正文。

## 最终版本自动化结果

平台：macOS。本地浏览器测试使用 Playwright Chromium，非原生 WebView 验收。

| 命令 | 结果 |
| --- | --- |
| `npm run check` | 0 错误、0 警告 |
| `npm test` | 50 文件、366 测试通过；0 失败 |
| `node --test scripts/desktop.test.mjs` | 3 通过、0 失败、0 忽略 |
| `npm run test:browser -- --workers=1` | 全套 99 通过、0 失败；包含新增 2 项目录回归 |
| `npm run build` | 通过；有大于 500 kB 的构建分块提示，未关闭该提示 |
| `npx prettier --check src tests *.ts *.js *.json src-tauri/*.json src-tauri/capabilities/*.json` | 通过 |
| `npx prettier --check src-tauri/bridge/desktop.mjs` | 通过 |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --check` | 通过 |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings` | 通过 |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked` | 66 通过、0 失败、1 项既有忽略 |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked platform::tests::installed_pi_starts_with_gui_path -- --ignored` | 既有本机 Pi 检测用例显式执行：1 通过、0 失败 |
| `git diff --check` | 通过 |

Rust 初次调用因 PATH 未包含工具链而退出 127，补充本机工具链 PATH 后执行以上完整三项，均通过。没有新增 skip、ignore 或关闭检查。

目录回归覆盖宽窄窗口、分页摘要不插入正文、读取失败重试、取消后不定位、旧消息补载、搜索空态、焦点恢复、草稿保留以及新内容不抢回底部。单元测试覆盖身份去重、相同文本保留、排队状态、Unicode 摘要及 Windows/POSIX 文件名。

本地详细日志位于 `.pi/validation-message-navigator/`；浏览器截图位于 `test-results/`。开发过程中发现并修复目录组件内容丢失导致入口缺失的问题，最终完整浏览器套件通过，不以局部重跑替代。

## 尚未验证

- Windows、Linux CI 与三个平台的原生打包、原生 WebView / 触控板操作。
- 实际生产超长会话及跨平台系统缩放组合的手工验收。
- 代码审阅与目录共存沿用已有布局，完整审阅回归已执行，但仍应在原生客户端复核。

因此状态为“本地实现及自动化通过，跨平台原生验收待验证”，不代表已完成三平台发布验证或 WCAG 审核。
