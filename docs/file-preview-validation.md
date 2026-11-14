# 对话文件预览验证记录

## 实现范围

- Markdown 本地链接、行内代码路径、文件卡片统一接入现有审阅区域，沿用所属会话工作目录。
- UTF-8 文本限量 256 KiB；签名识别的常见图片限量 10 MiB；Markdown 排版／源码切换；行号定位。
- 文档白名单系统打开，脚本、可执行权限文件、未知格式不直接运行；项目外访问就地确认，网络路径拒绝。
- 预览为磁盘当前内容，不是历史快照；不含 PDF／Office 内嵌渲染、非 UTF-8 转码、大文件全文分页。

## 最终版本本机检查（macOS）

| 命令 | 结果 |
| --- | --- |
| `npm run check` | 通过，0 错误、0 警告 |
| `npm test` | 57 文件、418 用例通过，0 失败 |
| `node --test scripts/desktop.test.mjs` | 3 通过，0 失败、0 跳过 |
| `CI=1 npm run test:browser` | 111 通过，0 失败；IPC 为模拟，不代替原生打开 |
| `npm run build` | 通过；保留主包超过 500 kB 的体积警告 |
| `npx prettier --check src tests '*.ts' '*.js' '*.json' 'src-tauri/*.json' 'src-tauri/capabilities/*.json'` | 通过 |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --check` | 通过 |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings` | 通过 |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked` | 88 通过，0 失败、1 既有忽略 |
| `git diff --check` | 通过 |

Rust 忽略项为 `platform::tests::installed_pi_starts_with_gui_path`，原有说明为“需要本机安装 Pi；通过最小 PATH 单独执行”。未删除、增加或绕过测试忽略。本次不将忽略项计为通过。

新增覆盖路径编码／中文／Windows 语法／行号、危险协议／网络路径拒绝、代码块不识别、代码样式链接标签不嵌套、项目外审批、符号链接边界（Unix）、二进制／文本限额／图片签名、脚本系统打开拒绝、迟到读取与重试。浏览器验证真实 Transcript／ReviewLayout 的宽屏浅色与窄屏深色面板、键盘关闭与焦点恢复、草稿保持、所属项目参数和系统打开请求。已检查截图 `test-results/file-preview-wide-light.png` 与 `test-results/file-preview-narrow-dark.png`，未发现溢出、截断或控件错位。

## 预览留白与视觉调整验证

本次仅修改 FilePanel 局部样式与浏览器夹具／断言：统一 24px／16px 水平留白、正文上下间距、分层标题和操作栏、圆角代码阅读区、柔和行定位、Markdown 阅读宽度、图片内边距及反馈区域。不改文件访问接口和其他审阅面板。

最终样式版本已执行：`npm run check`（0 错误、0 警告）、`npm test`（57 文件、418 通过）、`node --test scripts/desktop.test.mjs`（3 通过）、`CI=1 npm run test:browser`（111 通过）、`npm run build`（通过，主包体积警告保留）、上表 Prettier 命令（通过）、Rust fmt／Clippy（通过）、`cargo test --manifest-path src-tauri/Cargo.toml --locked`（88 通过、1 既有忽略）。平台为 macOS；无新增跳过。

首次将前端、浏览器与 Rust 全量套件同时运行时，模型选择大目录和插件页分类测试分别触发 5 秒超时（416 通过、2 失败）。日志显示多组无关测试耗时明显增加；随后取消套件间并行，在相同最终代码上依序执行前端完整检查，418 项全部通过，总耗时从 43.26 秒降至 16.32 秒。未修改超时、断言或忽略项。该次资源争用失败保留记录，不以单独重跑失败用例替代全量验证；后续验收应避免同时运行多套重型测试。

浏览器新增断言覆盖代码、Markdown、图片、错误、项目外授权、长路径的左右留白，以及 150% 缩放下关闭按钮可见和面板不横向溢出。保留原有系统打开、焦点恢复、行号及草稿断言。已人工查看宽屏代码、窄屏深色 Markdown、宽屏错误截图；几何断言覆盖其余状态。对应截图位于 `test-results/file-preview-*.png`。本次不增加原生／跨平台验证声明。

## 待验证范围与交付状态

本机自动化已通过（除上述既有显式忽略）；整体标记为**待原生／跨平台验证**，不宣称全测试零忽略或三平台发布完成。

- Windows、Linux 的 CI、原生打包及本机默认文件关联未在此 macOS 环境执行。
- macOS 原生 WebView、真实 Office／PDF／文件管理器关联打开未实机执行；浏览器仅验证 IPC 请求。
- 三平台仍需验证路径大小写／盘符、系统无关联应用时的错误、原生焦点与缩放；Windows 还需检查脚本和快捷方式拒绝策略。对应平台应运行项目全量清单并完成原生打包验收。
- 规范化与读取之间若有外部进程并发替换文件，当前实现不提供操作系统级文件身份锁定，不应视为对恶意并发文件系统的完整沙箱。
