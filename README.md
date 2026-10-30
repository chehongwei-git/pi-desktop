# Pi Desktop

复用本机 Pi 的精简桌面客户端。采用 Tauri 2、Svelte 5、TypeScript 与 Rust；通过 RPC 子进程连接 Pi，不附带 Pi、Node 或 Chromium。默认中文，核心布局与操作参考 ChatGPT 桌面版。

## 开始使用

需要先安装能够独立运行的 Pi（本版协议基线为 1.4.0）。Windows 需要系统 WebView2；安装器在缺少时联网引导安装。Pi npm 安装还需要 Node 22.19+。模型配置、凭据、登录、技能与工具继续由 Pi 管理。

```sh
npm ci
npm run desktop
```


```sh
npm run desktop
```

开发还需要 Rust stable 和平台构建工具。Windows 使用 Visual Studio C++ Build Tools 与 Windows SDK；macOS 使用 Xcode Command Line Tools；Linux 需要 GTK3、WebKitGTK 4.1、AppIndicator 等 Tauri 系统依赖。

打开后选择项目文件夹，客户端才启动 Pi。设置里可以指定 Pi 入口、Node/Bun、额外 PATH 或会话目录。标准 npm `pi.cmd` 会被解析成 Node + CLI JS，未知自定义 cmd 请改填 JS 入口和运行时。所有相对工具操作都以所选项目为工作目录。

## 已实现

- 单窗口、单活动 Pi：项目与最近项目、当前项目历史摘要搜索、新建/恢复/重命名。
- 流式正文、折叠思考与工具、停止并恢复排队草稿、运行中 steer/followUp。
- 模型与思考等级、命令提示、扩展 select/confirm/input/editor 及基础通知。
- 明暗主题、Markdown 清洗、代码复制、延迟高亮、动态高度虚拟列表、大正文分块。
- 有界消息通道、临时事件 spool、确认游标、Windows Job / Unix 进程组回收。

不会显示或管理 Pi 凭据；不提供内置终端、文件树、并行 Agent、上传、语音、历史编辑或自动更新。扩展兼容性和平台限制见 [兼容说明](docs/compatibility.md)。

## 检查与构建

```sh
npm run check
npm test
npm run test:browser
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri -- build
```

浏览器测试在 Windows 使用系统 Edge，其他平台先运行 `npx playwright install chromium`。Rust 子进程测试使用 `tests/fixtures/mock-pi.mjs`，要求 Node 可发现；不调用在线模型或用户会话。默认 Windows 构建 NSIS；macOS/Linux 的平台配置输出 unsigned app/deb。产物位于 `src-tauri/target/release/bundle/`。

## 文档

- [架构与维护规范](docs/architecture.md)
- [交互说明](docs/interaction.md)
- [RPC 与平台兼容说明](docs/compatibility.md)
- [排错](docs/troubleshooting.md)
- [验证记录与尚待验收项目](docs/validation.md)

`PLAN.md` 保留原始目标；验证记录区分已跑的检查与尚未完成的实机、性能验收。
