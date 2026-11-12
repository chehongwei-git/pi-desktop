# 插件中心验证记录

状态：**待验证／部分实施，不满足完整原计划发布条件**。

## 错误反馈跨分类残留修复：最新验证

Windows 本机验证通过，macOS/Linux CI 与三平台原生打包仍待验证。本次操作错误及状态反馈在确认切换分类、接入方式、查看详情或返回列表时清理；取消离开仍保留草稿与错误。导航会使旧详情请求失效，迟到的失败不能恢复错误或移动焦点；待应用会话记录独立保留。

新增 3 项组件回归：来源校验错误及“结果未确认”状态在切换分类后消失、旧详情请求迟到失败不回写/抢焦点、取消离开保留输入而确认离开清理错误。明暗主题浏览器场景增加报错后连续切换 Skills/扩展的断言，继续由既有套件与 CI 自动发现。

最终代码修改后完整执行：

| 命令 | 实际结果 |
| --- | --- |
| `npm run check` | 0 错误、0 警告 |
| `npm test` | 55 个文件，412 通过，0 失败、0 忽略 |
| `node --test scripts/desktop.test.mjs` | 3 通过，0 失败、0 忽略 |
| `npm run test:browser` | 109 通过，0 失败、0 忽略；完整 CI 串行配置 |
| `npm run build` | 成功；保留 Vite 大于 500 kB chunk 提示 |
| `npm exec -- prettier --check src tests '*.ts' '*.js' '*.json' 'src-tauri/*.json' 'src-tauri/capabilities/*.json' src-tauri/bridge/desktop.mjs` | 全部匹配文件通过 |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --check` | 通过 |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings` | 退出码 0；仍有 Windows 增量缓存目录整理拒绝访问的环境告警，无代码 lint 失败，未关闭检查 |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked` | 86 通过，0 失败，1 项既有忽略；main/doc-tests 各 0 项 |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked platform::tests::installed_pi_starts_with_gui_path -- --ignored --exact` | 补充单独执行，1 通过、0 失败；全量套件仍如实记为 1 ignored |
| `git diff --check` | 通过 |

本机 Pi 补充项首次在编译阶段超过工具 60 秒时限；最终在全量检查后通过后台执行保存完整输出，退出码 0。npm 用户配置、既有 MessageEdit 测试替身绑定提示、Vite 包体积及 Rust 增量缓存告警均未隐藏或通过降低检查标准处理。检查了实际错误区域截图；浏览器断言确认切换后旧提示不再存在。

日志位于本机临时目录 `pi-feedback-final-*.log`，全量命令退出码汇总为 `pi-feedback-final-results.json`，Pi 补充项为 `pi-feedback-native.log`。未新增忽略项、未改动用户 Pi 配置，跨平台与原生打包范围仍按下方记录的限制处理。

## 在线搜索与全局安装：本轮验证

状态：**在线安装实现已落地，Windows 本机验证通过；macOS/Linux CI 与三平台原生打包待验证，不构成发布完成声明**。插件中心其余原计划缺口仍见 `plugins.md`，下方前序记录保留供追溯。

环境：Windows，Node v24.13.0，Rust 1.93.1，Pi 1.5.2；浏览器使用系统 Edge。未修改现有 `.openidea/` 和 `installHuanJing.md`，未安装到用户日常 Pi 配置，未调用在线生成模型。

### 最终代码全量命令

所有下列检查均在最后一次代码与测试修改后执行；没有新增 skip/ignore 或关闭检查。

| 命令 | 实际结果 |
| --- | --- |
| `npm run check` | 0 错误、0 警告 |
| `npm test` | 55 个文件，409 通过，0 失败、0 忽略 |
| `node --test scripts/desktop.test.mjs` | 3 通过，0 失败、0 忽略 |
| `npm run test:browser` | 109 通过，0 失败、0 忽略；CI 串行配置，完整执行 |
| `npm run build` | 成功；主 JS chunk 586.33 kB，保留大于 500 kB 的 Vite 提示 |
| `npm exec -- prettier --check src tests '*.ts' '*.js' '*.json' 'src-tauri/*.json' 'src-tauri/capabilities/*.json' src-tauri/bridge/desktop.mjs` | 全部匹配文件通过 |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --check` | 通过 |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings` | 退出码 0，无代码 lint 失败；Cargo 重放 lib/lib test 增量缓存目录整理时的 Windows 拒绝访问告警（os error 5），未关闭检查或改动 lint 设置 |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked` | 86 通过，0 失败，1 项既有本机安装测试 ignored；main 与 doc-tests 各 0 项 |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked platform::tests::installed_pi_starts_with_gui_path -- --ignored --exact` | 单独执行既有忽略项，1 通过、0 失败；不把全量套件中的 ignored 改报为 0 |
| `git diff --check` | 通过 |

npm 另提示用户既有 disturl、sass_binary_site、electron_mirror 配置将被未来版本移除；本次没有修改用户 npm 配置。单元测试既有 MessageEdit 替身仍输出非响应式绑定提示，相关断言通过，类型检查无警告。首轮开发检查发现的按钮异步断言、jsdom 布局观察与几何夹具缺失、详情 DOM 引用非响应式提示均已修正；收尾修复后重新执行了完整清单，未用局部重跑替代最终全量检查。

### 本轮新增覆盖与实际渲染

- npm 包名、scoped 包名、精确版本和标签解析；版本范围、完整 npm/npx/Pi 命令与控制字符拒绝；scoped URL 编码。
- registry 状态、429 限流、无效 JSON、Content-Length 与 chunked 大小上限、超时、两路查询部分成功和去重。
- 普通名称查询后选包、未标记包兼容性确认、固定版本安装、重复提交阻止、已有全局包识别、从项目列表进入仍传全局安装参数。
- 过期搜索与详情响应丢弃；安装结果不确定时仅重新读取；核对未安装后显式重新选择；输入保留和导航草稿保护。
- 浏览器完整路径：查询 → 选包 → 全局安装 → 读取确认 → 查看已安装包。浅色 1200px、深色 600px，100% 和 200% 在线安装截图，原有 125%/150% 选择器场景也继续通过。
- 已读取检查 `test-results/plugins-light-online-install.png` 与 `test-results/plugins-dark-online-zoom-2.png`：长 scoped 名称换行、详情与按钮样式协调；高缩放保持标题与分类上下文，详情在插件页内滚动。未宣称完成 WCAG 全面审核或原生 WebView 视觉验收。

### 真实 Pi 安装与重载

使用临时 agent 目录、临时 npm 缓存、空 npm 用户/全局配置和仅监听本机的受控 registry，构造无安装脚本、无第三方依赖的 `pi-desktop-controlled-test@1.0.0` 测试包。真实执行 Pi `install npm:pi-desktop-controlled-test@1.0.0`，确认个人 `settings.json` 有声明且测试项目未生成 `.pi/settings.json`。

随后真实启动隔离 RPC 会话并加载桌面桥接扩展，`get_commands` 找到测试包提示词，执行 `/pi-desktop-reload-v1` 后再次确认资源仍存在；未发送模型请求。两项验收通过，进程、HTTP 服务和临时配置/包文件均已清理。另对公开 npm 搜索与选中版本元数据做了只读连通性核对，没有下载执行真实第三方包。

### 本轮边界与后续验收

仅验证 Windows 本机 CLI/RPC 和 Edge 页面，未运行 macOS/Linux runner、三平台原生打包、真实第三方包脚本、私有源、真实 OAuth 或 Git 安装组合。新增组件、Rust 与浏览器用例均已纳入现有自动发现套件；发布前需执行三平台 CI 与原生打包/界面验收。跨页面持久任务与更完整资源管理仍不在本次范围。

本轮命令日志位于本机临时目录 `pi-online-final-*.log`，汇总为 `pi-online-final-results.json`；隔离安装验收为 `pi-online-native.log`。这些临时日志不进入发行包。

## 前序插件中心与视觉精修记录（macOS）

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
