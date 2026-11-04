# 长文本卡片实现验证记录

> 此为首轮实现的历史验证记录。当前双路径交互及最终检查结果见 [长文本双路径验证记录](text-message-validation.md)。

## 实现范围

- 单次粘贴达到 1,000 个 Unicode 码点或 12 行，在原位置收纳为两行卡片；前后文字、多张卡片按顺序拼接，发送和复制保留全文。
- 内嵌展开编辑、还原文字、移除、撤销/重做、卡片边界两步删除；图片粘贴、命令、历史召回继续使用现有入口。
- 草稿保存结构化片段；兼容旧字符串和损坏片段回退，保留失败草稿及发送期间的新编辑，覆盖新会话状态迁移。
- 浅深主题、窄窗口以及 102,000 字符内容已在浏览器用例验证。截图位于 `test-results/paste-card-light.png`、`test-results/paste-card-dark.png`；截图已生成，未进行人工视觉验收。

## 最终版本全量检查

环境：Windows，Node.js 24.13.0，Playwright 使用系统 Edge。下表来自最后一次完整检查，期间没有修改实现文件。

| 命令 | 结果 |
| --- | --- |
| `npm run check` | 0 错误、0 警告 |
| `npm test` | 39 个测试文件、304 条通过，0 失败、0 忽略 |
| `node --test scripts/desktop.test.mjs` | 3 通过、0 失败、0 跳过 |
| `npm run test:browser -- --workers=1` | 全量 86 通过、0 失败、0 跳过 |
| `npm run build` | 退出码 0 |
| `npx prettier --check src tests *.ts *.js *.json src-tauri/*.json src-tauri/capabilities/*.json` | 全量通过 |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --check` | 退出码 0 |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings` | 退出码 0；有本机增量缓存权限警告，见下文 |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked` | 54 通过、0 失败、1 原有忽略；主程序与文档测试各 0 条 |
| `git diff --check` | 通过 |

没有新增测试套件入口；新用例由现有 Vitest/Playwright 全量命令自动收集，沿用既有 CI。

## 排查与修正

- 新增测试的异步初始化、提交 mock 同步和泛型类型问题已修正，最终全量通过。
- 工具高亮失败定位为 Vite 依赖缓存缺失，浏览器直接动态导入 `highlight.js` 返回加载错误；重启本次启动的 Vite 并用 `--force` 重建缓存后，直接高亮调用及全量用例均通过。
- 展开历史滚动用例逐帧测量 240 条消息、发送 90 次原生滚轮，在本机接近/超过原 30 秒测试上限。仅将展开场景总时间改为 60 秒，保留全部步数、事件送达、锚点误差和 DOM 数量断言，未增加跳过或重试。
- 本机 `core.autocrlf=true` 使大批已有文件以 CRLF 检出；执行项目 Prettier 统一工作区换行，另保留三处已有排版修正（ChangePanel、PlanMessage 测试、project-model 测试），没有改变其行为。
- 验证运行器的临时 JSON 缺末尾换行曾被全量格式检查捕获，已修正；运行器与临时状态在交付前清理。

## 待验证范围和环境限制

- Rust 原有忽略项：`platform::tests::installed_pi_starts_with_gui_path`，原因是需要本机 Pi 和最小 PATH 环境。本次未把忽略项计为通过；后续须在隔离的最小 PATH 环境运行 `cargo test --manifest-path src-tauri/Cargo.toml --locked installed_pi_starts_with_gui_path -- --ignored`。
- Clippy/Cargo 测试退出码为 0，但 Rust 增量缓存目录最终写入出现 Windows `os error 5` 权限警告；后续清理本机缓存权限或使用独立可写构建目录再次验证。
- 未完成 macOS、Linux 和三平台原生 WebView 的真实中文输入法、系统剪贴板、选区与 Ctrl/Cmd 快捷键验收；浏览器合成组合输入事件不能替代真实 IME。
- 未完成人工视觉评审、卡片专门的 200% 缩放与系统主题实时切换验收，也未进行三平台原生打包与发布 CI。

状态：功能已实现，本机必需自动化命令均成功退出；原有忽略项、原生交互和发布验收仍待验证，不宣称全部平台验收完成。
