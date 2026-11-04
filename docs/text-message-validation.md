# 长文本双路径验证记录

本记录对应“点击输入卡片还原，直接发送卡片后右侧查看”的最终实现，取代首轮实现记录对当前交互的描述。

## 实现结果

- 输入卡片点击、Enter 或 Space 激活后，在原位置被完整原文替换，卡片消失；保留前后文字，光标位于原文末尾，可撤销恢复卡片。
- 普通用户长消息（含旧历史）默认显示最多 6 行、360 码点预览，点击“展开更多”在消息内阅读和收起。
- 未还原的卡片直接发送后保持只读卡片，点击在右侧查看全文。文本和代码变更共用审阅区域，窄窗口在原对话区域显示；关闭后恢复卡片焦点及阅读位置。
- 混合内容保持顺序，普通长片段独立折叠。“复制消息”读取整条完整原文，“复制原文”只复制右侧卡片全文。
- 桌面发送元数据只描述范围，宿主校验 UTF-16 边界并在调用 Pi 前剥离展示字段；原文不变。独立 sidecar 按会话身份、原始消息时间和正文/图片摘要绑定，不修改 Pi JSONL。
- 缺少稳定身份时仅内存保留并提示；有歧义、损坏或不匹配的记录回退为普通文字。取消排队、拒绝及超时清理待绑定记录，不自动重发。
- 分页失败保留已读内容并可重试，切换面板丢弃旧结果。大正文按 64KiB 批量发布，片段预览计入现有缓存预算。

## 最后一轮完整检查

平台：Windows，Node.js 24.13.0；浏览器使用系统 Edge。最后一轮期间未修改实现、测试或配置。

| 命令 | 结果 |
| --- | --- |
| `npm run check` | 0 错误、0 警告 |
| `npm test -- --maxWorkers=2 --minWorkers=1` | 全量 41 个文件、310 条通过，0 失败、0 忽略 |
| `node --test scripts/desktop.test.mjs` | 3 通过、0 失败、0 跳过 |
| `npm run test:browser -- --workers=1` | 全量 88 通过、0 失败、0 跳过 |
| `npm run build` | 成功，退出码 0 |
| `npx prettier --check src tests *.ts *.js *.json src-tauri/*.json src-tauri/capabilities/*.json` | 全量通过 |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --check` | 成功，退出码 0 |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings` | 退出码 0；有本机增量编译缓存权限警告 |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked` | 57 通过、0 失败、1 原有忽略；主程序和文档测试各 0 条 |
| `git diff --check` | 通过 |

降低测试并发只用于控制本机资源，未筛选用例。新增测试由既有 Vitest、Playwright、Cargo 命令自动收集，沿用现有 CI 套件。

最终命令日志和状态保存在 `test-results/text-message-validation/`，后续 Playwright 运行可能清除此目录，本记录保留检查结论。

## 覆盖与排查

- 浏览器验证两条路径、卡片消失与原位替换、撤销/重做、两步删除、跨卡片剪切与复制、多卡片混排、失败保留、草稿和发送后历史重启恢复。
- 验证超过 64KiB 和十万字符正文、右侧分页失败重试、整条全文与单卡片复制、文本和代码变更切换、迟到结果隔离、焦点恢复及保留同一对话 DOM。
- 验证明暗主题、窄窗口及 200% CSS 缩放无横向溢出；生成截图 `test-results/sent-text-card-light.png`、`sent-text-card-dark.png`、`sent-text-panel-light.png`、`sent-text-panel-dark.png`。截图未作人工视觉评审。
- Rust 测试覆盖 Unicode 范围边界、完整覆盖校验、会话隔离、sidecar 恢复、拒绝清理、歧义候选及损坏文件回退。真实 Node 子进程的 20 轮生命周期测试验证展示字段不透传 Pi，并能从宿主引用读取原文。
- 全量检查发现的测试类型和异步等待问题已修正，保留原断言。
- 浏览器测试曾复用开发服务导致动态导入失效；现在使用独立 1421 端口与 Vite `browser-test` 模式缓存，应用开发端口仍是 1420。全局启动准备先加载页面并校验 TypeScript 高亮，正式用例仍采用原有断言和各自超时。
- 配置修改期间的热更新影响过中间验证轮次；最终稳定版本已重新执行全部检查，未用单条重跑替代全量通过。

## 待验证范围

- 原有忽略项 `platform::tests::installed_pi_starts_with_gui_path` 需要本机 Pi 与最小 PATH；未计为通过。后续在对应隔离环境运行 `cargo test --manifest-path src-tauri/Cargo.toml --locked installed_pi_starts_with_gui_path -- --ignored`。
- Clippy 成功退出，但 Windows Rust 增量缓存目录写入出现 `os error 5` 权限警告；后续修复缓存权限或在独立可写构建目录复核。
- 未执行 macOS、Linux、三平台原生打包与发布 CI；真实原生 WebView 的中文输入法、系统剪贴板、系统主题切换及平台快捷键仍需验收。浏览器合成事件和 CSS 缩放不代表原生系统验收完成。
- 实际 Pi 提供方和所有扩展组合没有在线端到端验证；身份不足时的普通文字降级为显式兼容行为，不保证外部工具生成的消息都能恢复卡片。

状态：双路径功能已实现，本机必需自动化命令全部成功退出；原有忽略项、人工视觉和跨平台原生发布验收待验证。
