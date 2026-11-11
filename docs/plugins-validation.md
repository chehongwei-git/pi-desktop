# 插件中心验证记录

状态：**待验证／部分实施，不满足完整原计划发布条件**。

环境：macOS arm64，Node v22.23.2，Rust 1.90.0，本机 Pi 1.4.0。原有 `.openidea/`、`.pi/` 未跟踪文件未修改。没有安装或更新用户的实际第三方包，没有调用在线生成模型。

## 视觉精修验收

本轮在 macOS Chromium 执行真实组件浏览器验收，浅色 1200px、深色 600px；缩放 100%/125%/150%。截图在 `test-results/plugins-*.png`（测试输出，非发行资源）。验证不代表原生 WebView、三个平台、真实输入法或 WCAG 完整审核。

| 页面/状态 | 覆盖与结果 |
| --- | --- |
| MCP / Skills / 扩展列表 | 明暗宽窄截图；停用开关、长名称/路径、用户/内置/包分组 |
| HTTP / stdio / JSON / 本地 Skill / 安装包表单 | 截图及模式切换保留草稿断言 |
| 确认预览 / 返回编辑 | 只读摘要、源字段隐藏、切换重置管理页滚动 |
| MCP / Skill / 扩展详情 | 元信息、操作区域、Markdown 长正文真实渲染 |
| 下拉展开 / 多项目搜索 / 无匹配 | 搜索名称及路径，Enter 选择、Escape 返回焦点；125%/150% 下不超出横向视口 |
| 未保存离开 / 移除确认 | 页内确认截图、取消保留表单 |
| 保存及待应用 | 启停后页内反馈与待应用租约展示，不冒充已连接 |
| 空列表 / 外部冲突错误 / 延迟加载 | 可控异步夹具截图与断言；读取期间禁用范围入口 |

本轮未新增宿主功能；真实 OAuth/安装、会话实时 MCP、跨页面持久任务等原有缺口仍见下文。未穷举所有主题×宽度×状态组合，Windows/Linux 原生视觉与进程行为待 CI 和人工验证。

## 最终代码全量命令

| 命令 | 实际结果 |
| --- | --- |
| `npm run check` | 0 错误、0 警告 |
| `npm test` | 53 个测试文件，374 通过，0 失败、0 忽略 |
| `node --test scripts/desktop.test.mjs` | 3 通过，0 失败、0 忽略 |
| `npm run test:browser` | 103 通过，0 失败、0 忽略；完整默认配置 |
| `npm run build` | 成功；Vite 有大于 500 kB chunk 的体积提示，未关闭告警 |
| `npx prettier --check src tests '*.ts' '*.js' '*.json' 'src-tauri/*.json' 'src-tauri/capabilities/*.json' src-tauri/bridge/desktop.mjs` | 通过 |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --check` | 通过 |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings` | 通过 |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked` | 72 通过，0 失败，1 项既有本机安装测试 ignored |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked platform::tests::installed_pi_starts_with_gui_path -- --ignored --exact` | 单独执行既有忽略项，1 通过；不改变全量套件仍含 1 ignored 的事实 |
| `git diff --check` | 通过 |

工具链需将现有 `$HOME/.cargo/bin` 加入本次命令环境 PATH；未修改项目脚本或系统配置。首轮新增同名 Skill 检查曾有 clippy collapsible_if 错误，已修正并重新执行全部上述自动化检查，而非只重跑该项。

## 新增覆盖

- MCP 项目覆盖保留全局凭据与未知字段，恢复继承。
- 外部配置冲突、目录锁、损坏 JSON 不覆盖。
- Skill 启停不改源文件；外部接入声明在启停后仍保留。
- 非法 MCP 名称、规范化同名、来源命令行注入拒绝。
- 页面扫描不执行诊断，连接检查需要明确确认。
- 新增预览、保存失败保留输入、离开时页内草稿保护。
- Playwright 浅色 1200px、深色 600px 布局及启停流程。已读取并检查实际渲染截图；最后修正测试夹具缺少 save_settings 导致的无关错误条后，全量浏览器再次通过。最终截图在 `test-results/plugins-light-1200.png`、`test-results/plugins-dark-600.png`。

## 未验证范围与后续方式

- Windows、Linux runner、三平台原生打包和 GUI 安装/卸载未执行。现有 CI 会自动发现新增测试；需推送后核对三平台结果及原生进程树行为。
- 实际 npm/Git 包安装、项目 trust 组合、真实 OAuth、远程 MCP 登录与本地服务器连接未执行；需在隔离 agent 目录和测试项目中逐项验收，避免修改用户环境。
- Pi 包 manifest 的资源发现/过滤、安装前资源清单、实时 MCP 工具和连接接口、跨页面任务及待应用状态未完整实施，见 `plugins.md`，不可视为环境测试通过即可补齐。
- 页面重载复用现有 Action，但新的多实例待应用流程仍需要真实 Pi 组合验证。没有宣称完整 WCAG 2.2 AA 符合性或三平台兼容验收完成。

本轮原始最终输出保存在本机临时目录 `/tmp/plugin-polish-*.log`；先前功能验证为 `/tmp/pi-plugin-final-*.log`，本记录提供稳定摘要；日志不会进入发行包。
