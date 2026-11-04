# Pi Desktop

**为本机 Pi 提供轻量的桌面工作区。**

Pi Desktop 使用 Tauri 2、Svelte 5、TypeScript 与 Rust 构建，通过 RPC 子进程连接已安装的 Pi，将项目、会话、模型配置和工具执行整合到默认中文的桌面界面中。复用系统 WebView，不捆绑 Pi、Node.js 或 Chromium。

> 当前版本：**0.1.0**，仍在持续开发。目标平台为 Windows、macOS 和 Linux，但各平台的验证范围不同；构建配置齐全不代表已完成三平台原生验收。详见[兼容说明](docs/compatibility.md)与[验证记录](docs/validation.md)。

[快速开始](#快速开始) · [主要功能](#主要功能) · [开发与测试](#开发与测试) · [构建安装包](#构建安装包) · [文档](#文档)

## 主要功能

- **项目与会话管理**：按项目浏览历史，支持跨项目搜索、最近会话、置顶、重命名、项目排序，以及统一的归档、筛选与恢复。
- **多会话并行**：切换项目或会话时，后台任务继续执行；默认同时运行 4 个会话，可配置为 1–16 个，超出额度的任务按队列等待。
- **流式对话与工具详情**：实时展示回复，将思考与工具调用归入可展开的“处理过程”；支持代码高亮、复制、长输出分块读取和内嵌差异面板。
- **图片消息**：支持选择、粘贴或拖入图片，提供缩略图与原地预览；是否可发送由模型能力决定。
- **模型与思考强度**：按会话切换模型和思考等级，在设置页管理自定义 API 端点、API Key、模型发现与参数，并与本机 Pi 共用配置。
- **运行中控制**：支持停止任务、发送引导（steer）与完成后发送（followUp），就地展示排队、失败及可恢复状态。
- **命令与扩展交互**：提供斜杠命令补全，适配基础选择、确认、输入、编辑与通知；可展示已有 Plan 扩展提供的执行计划。
- **连续的工作上下文**：切换时保留草稿、工具展开状态与阅读位置；文字草稿可在重启后恢复，任务不会自动续跑。
- **桌面体验**：支持跟随系统、浅色和深色主题、常用键盘快捷键；设置与归档在主内容区完成。

## 快速开始

### 1. 准备环境

Pi Desktop 是桌面客户端，**不能替代 Pi 本身**。请先安装 Pi，确认它能在终端独立启动。

源码运行还需要以下环境：

| 依赖 | 要求 |
| --- | --- |
| Pi | 本机已安装且可独立运行；协议最初参考 1.4.0，1.5.0 的部分真实进程行为已有验证，具体范围见[兼容说明](docs/compatibility.md) |
| Node.js 与 npm | 推荐 Node.js 24，与 CI 保持一致；运行 Pi 时还需满足其发行版本的要求 |
| Rust | 推荐当前 stable 工具链，包含 Cargo |
| 平台构建依赖 | 见下表及 [Tauri 2 环境准备文档](https://v2.tauri.app/start/prerequisites/) |

| 平台 | 主要依赖 |
| --- | --- |
| Windows | Visual Studio C++ Build Tools、Windows SDK、WebView2 |
| macOS | Xcode Command Line Tools |
| Linux | GTK 3、WebKitGTK 4.1、AppIndicator 等，具体包名依发行版而定 |

已打包的客户端不需要 Rust 或本项目的前端开发依赖，但仍需要 Pi、Pi 所需的运行环境和系统 WebView。Windows 安装器配置了缺少 WebView2 时的联网引导。

### 2. 从源码启动

克隆或下载仓库后，在项目根目录执行：

```sh
npm ci
npm run desktop
```

`npm run desktop` 同时管理 Vite 与 Tauri 的开发生命周期，退出时释放开发服务。`npm run dev` 仅启动前端服务，不会启动原生桌面宿主。

### 3. 连接并开始对话

1. 打开 **设置 → Pi 连接**，使用“检测 Pi”确认入口与运行环境；自动发现失败时，手动指定 Pi 入口、运行时或额外 PATH。
2. 在新对话的项目入口选择工作目录，或从侧栏打开已有项目、会话。工具的相对路径操作以该项目目录为基准。
3. 使用已有 Pi 模型配置，或在 **设置 → 模型与服务商** 中添加自定义端点、配置 API Key 和模型。
4. 选择模型与思考强度，输入消息并发送。运行中可切换到其他会话，任务状态会继续显示在侧栏。

桌面应用继承的 PATH 可能与终端不同。遇到“未找到 Pi”、启动超时或开发端口被占用，请查看[排错指南](docs/troubleshooting.md)。

### 常用快捷键

macOS 使用 `Cmd`，Windows / Linux 使用 `Ctrl`。

| 快捷键 | 操作 |
| --- | --- |
| `Ctrl/Cmd + N` | 新对话 |
| `Ctrl/Cmd + K` | 搜索 |
| `Ctrl/Cmd + B` | 切换侧栏 |
| `Ctrl/Cmd + ,` | 打开设置 |
| `Enter` / `Shift + Enter` | 发送 / 换行 |
| `↑` / `↓` | 空输入时召回提示词并浏览发送历史 |

## 数据与能力边界

- **复用本机 Pi**：会话由 Pi 写入，桌面读取历史并维护本地偏好与缓存；模型设置与 Pi 共用 `models.json`、`auth.json` 和 `settings.json`。修改模型配置也会影响使用同一配置目录的 CLI。
- **凭据与网络**：设置页可写入新的 API Key，但不回显已有原始凭据。模型发现会请求配置的服务地址，模型调用由 Pi 执行；本项目不是离线模型，也不是 Agent 沙箱。
- **草稿恢复**：文字草稿在本机持久化；图片附件仅保存在内存，重启后需要重新添加。中断或排队任务不会在重启后自动提交。
- **扩展兼容**：桌面通过临时桥接扩展适配部分能力，不修改 Pi 安装源码或覆盖用户扩展。计划能力由用户自行安装的扩展提供；任意 TUI 自定义组件和交互式终端界面不能原样呈现。
- **当前限制**：没有内置终端、文件树、语音、OAuth 登录界面或自动更新；部分 CLI 命令尚未适配。长历史按需加载，但不承诺任意规模对话都保持恒定内存。

完整支持范围、模型协议限制与平台差异见 [RPC 与平台兼容说明](docs/compatibility.md)。

## 开发与测试

在项目根目录执行：

```sh
# 类型与 Svelte 检查
npm run check

# 前端单元与组件测试
npm test

# 开发启动脚本回归测试
node --test scripts/desktop.test.mjs

# 前端生产构建（不是桌面安装包）
npm run build

# Rust 格式、静态检查与测试
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --locked
```

浏览器集成测试：

```sh
# macOS / Linux 首次执行前安装 Chromium
npx playwright install chromium

npm run test:browser
```

Windows 浏览器测试默认使用系统 Edge。浏览器测试模拟 IPC，不能替代原生客户端验收；Rust 子进程测试使用 `tests/fixtures/mock-pi.mjs`，需要能发现 Node.js，不调用在线模型或用户会话。各阶段已执行的检查与已知阻塞见[验证记录](docs/validation.md)。

## 构建安装包

完成环境准备和 `npm ci` 后，在对应目标系统执行：

```sh
npm run tauri -- build
```

Tauri 会自动合并对应平台的配置并构建前端：

| 平台 | 默认产物 | 配置文件 |
| --- | --- | --- |
| Windows | NSIS 安装器 | `src-tauri/tauri.conf.json` |
| macOS | 未签名 `.app` | `src-tauri/tauri.macos.conf.json` |
| Linux | `.deb` | `src-tauri/tauri.linux.conf.json` |

产物位于 `src-tauri/target/release/bundle/`。当前未配置代码签名、公证或自动更新，macOS / Linux 产物仍需进一步原生验收。

仓库包含 [GitHub Actions 检查配置](.github/workflows/check.yml)，分支推送、Pull Request 或手动触发时，在三个平台执行检查、测试与构建，并上传未签名验证产物。macOS `.app` 先归档为 `.app.tar.gz`，避免下载后丢失执行权限。

### 发布 GitHub Release

[Release 流程](.github/workflows/release.yml) 在推送 `v*` 标签时运行：校验版本 → 复用三平台检查与打包 → 创建草稿并上传附件 → 公开 Release。任何平台失败都不会进入发布步骤；上传失败时可重新运行工作流补齐草稿，已公开的版本则禁止覆盖。

1. 在 GitHub 新建空仓库（不要初始化 README），允许仓库运行 GitHub Actions。组织策略也必须允许工作流使用 `contents: write`；流程仅对发布作业申请此权限，使用自动提供的 `GITHUB_TOKEN`，不需要新增 PAT Secret。
2. 保留现有 Gitee `origin`，添加 GitHub 远程并推送当前分支（替换示例地址）：

   ```sh
   git remote add github https://github.com/YOUR_ACCOUNT/pi-desktop.git
   git push -u github HEAD
   ```

3. 提交所有待发布改动后，确认 `package.json`、`package-lock.json`（包括根包记录）、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml` 的版本一致，并更新 `src-tauri/Cargo.lock` 中本项目的版本。当前版本为 `0.1.0`。未来升级版本后应重新运行测试并提交锁文件。
4. 推送版本标签，即授权自动公开该版本：

   ```sh
   git tag -a v0.1.0 -m "Release v0.1.0"
   git push github v0.1.0
   ```

5. 在 GitHub → Actions 查看 `desktop-release`，全部成功后在 Releases 下载附件。只推送分支不会创建 Release。当前仅支持 `v主版本.次版本.修订版本` 正式版本，不支持预发布标签。

默认发布 Windows runner 原生架构的 NSIS `.exe`、macOS runner 原生架构的 `.app.tar.gz`、Ubuntu 24.04 构建的 `.deb`；不提供 macOS Universal / 双架构包，也不保证 `.deb` 兼容所有 Linux 发行版。macOS 归档解压后得到 `.app`，不是 `.dmg` 安装镜像。未配置代码签名与公证，Windows SmartScreen / macOS Gatekeeper 可能提示或阻止运行。

发布配置仍需在 GitHub 上实际运行三平台流水线验证；本地前端检查通过不代表安装包已完成三平台原生验收。

## 项目结构

```text
assets/            图标源文件
src/               Svelte 界面、会话状态与 IPC 客户端
src-tauri/         Rust 宿主、Pi 进程管理、RPC 与本地存储
extensions/        桌面桥接扩展源码
scripts/           开发启动与专项验证脚本
tests/             单元、组件、浏览器测试与协议夹具
docs/              架构、交互、兼容性与验证文档
.github/workflows/ 跨平台 CI 配置
```

## 文档

- [架构与维护](docs/architecture.md) — 模块职责、进程池、调度、数据与缓存策略
- [交互说明](docs/interaction.md) — 项目、会话、模型设置、图片与阅读行为
- [RPC 与平台兼容说明](docs/compatibility.md) — 支持能力、版本差异与限制
- [排错指南](docs/troubleshooting.md) — Pi 发现、启动失败、历史与日志
- [验证记录](docs/validation.md) — 实际执行结果及尚待验收范围
- [开发约定](AGENTS.md) — 交互、代码质量与跨平台要求

`PLAN.md` 保留早期设计目标，不作为当前功能或验收完成情况的承诺。

## 反馈与贡献

欢迎通过 Issues 提交问题或建议。报告问题时，请附上操作系统与架构、Pi Desktop / Pi 版本、复现步骤和脱敏后的错误信息。不要提交 API Key、认证文件、完整环境变量或含敏感内容的会话记录。

提交代码前请遵循 [开发约定](AGENTS.md)，运行与改动相关的检查和测试；涉及交互或兼容性变化时同步文档，并注明未验证的平台与场景。

## 许可证

本项目采用 [Apache License 2.0](LICENSE)（SPDX：`Apache-2.0`）。除另有声明外，本仓库的原创代码与文档按此许可证提供。

第三方依赖、代码及资源仍遵循各自的许可证与版权声明，本项目的许可证不替代其许可要求。
