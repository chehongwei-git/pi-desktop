# 验证记录

当前交付为 0.1.0 首版，源码实现以 PLAN.md 为目标。下表记录本机实际执行结果，不把 CI 配置、浏览器模拟或目标值当成实机验收。

| 检查 | 本机结果 |
| --- | --- |
| Node / Rust | Node 24.13.0、Rust 1.93.1，Windows x64 |
| TypeScript / Svelte | `npm run check`，0 错误、0 警告 |
| 前端单元/组件 | `npm test`，13 项通过 |
| 浏览器集成 | 系统 Edge，2 项通过：欢迎/连接/发送/快捷键，10,000 条消息虚拟化/上滚 |
| Rust 格式 | cargo fmt --check 通过 |
| Rust 静态检查 | cargo clippy --all-targets -- -D warnings 通过；本机关闭增量缓存绕开缓存拒绝访问 |
| Rust 测试 | 8 项通过，包含真实 Node 管道的 20 轮生命周期，约 3.8 秒 |
| IPC 契约 | Rust/TS 共用 event-batch.json，覆盖 camelCase/null/正文引用 |
| 前端生产构建 | Vite build 通过；首屏 HTML+CSS+JS gzip 约 109.7KiB，不含延迟高亮 |
| Windows release | Tauri build 通过，生成 pi-desktop.exe |
| Windows NSIS | 生成 `Pi Desktop_0.1.0_x64-setup.exe`，约 1.68MiB，未签名 |
| 原生窗口冒烟 | `node scripts/smoke-windows.mjs`：窗口 Pi Desktop 可响应，WM_CLOSE 后退出码 0 |

原生冒烟一次采样宿主工作集约 27MiB，仅是空项目状态下 Rust 主进程，不包含 WebView2、Pi 和工具。不能据此推算总内存或作为固定承诺。

浏览器测试使用模拟 IPC；Rust 生命周期测试使用独立 mock-pi.mjs。没有为测试调用在线模型或重写真实 CLI 会话。10,000 条消息初始渲染观测到约 127ms 单次长任务；当前测试仅验证挂载消息少于 40 条与上滚交互，并未完成“滚动无持续 >100ms 长任务”的 release 性能验收。

NSIS 工具的 GitHub 直连超时，使用用户指定代理下载，Tauri 校验哈希后完成打包。本机使用临时环境变量（没有修改系统全局代理）：

```sh
TAURI_BUNDLER_TOOLS_GITHUB_MIRROR=https://v4.gh-proxy.org/https://github.com npm run tauri -- build --bundles nsis --ci
```

安装器位于 `src-tauri/target/release/bundle/nsis/`。安装/卸载、缺少 WebView2 的引导流程仍待独立 Windows 环境验证，未在当前开发机执行安装器。

## 模型配置增量验证（2026-07-17，macOS arm64）

本次新增设置内模型与服务商管理，实测结果：

- `npm run check`：0 错误、0 警告；`npm test`：135 项通过；`npm run build`：通过。
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`：24 项通过，新增配置无损合并、密钥不回传、锁冲突、OAuth 替换保护、损坏文件保护及模拟 HTTP 模型发现验证。
- 浏览器：本机 Chrome，44 项通过，包含新增服务商、远端拉取、四项模型能力、max 映射、保存及离开设置时保留草稿。IPC 为模拟，不能替代原生网络验收。Playwright 自带 Chromium 下载超时，因此使用临时 Chrome 配置执行，临时配置已移除。
- `node scripts/verify-model-config.mjs`：隔离目录中的真实 Pi 1.4.0 正确加载 contextWindow=200000、maxTokens=32000、图片输入、默认 max 和禁用 xhigh；模型刷新保持会话，未调用生成模型。
- `python3 scripts/verify-bridge.py`：真实 Pi 桥接加载、资源重载和模型刷新通过。
- Rust 新增源码使用 stable 工具链 rustfmt 格式化；默认 1.90 工具链未安装 rustfmt/Clippy，另一套 stable 为 1.87，不能构建当前依赖，因此 Clippy 未完成。

本次未进行 Windows/Linux 实机、原生安装包、真实远端服务鉴权、付费生成调用、断电/强杀多文件事务和完整无障碍标准验收。模型发现取消采用忽略迟到响应，宿主请求在 30 秒内超时；默认启动设置应重新连接后验证。标准 JSON 以外带注释的 models.json 暂不支持编辑。特殊认证头、命令型密钥和 OAuth 模型发现暂不支持，保留手动模型入口。跨平台实现采用 Rust/Node 路径及进程 API，以上不构成三平台验证完成声明。

## 自定义端点页面调整验证

页面改为自定义端点列表与详情，移除新增内置服务商及目录覆盖入口，保留隐藏 CLI 配置。参考 npm 包 @rotriz/pi-web-ui 1.6.0 的搜索模型列表；该版本本身没有端点配置表单。

- `npm test`：137 项通过，新增隐藏 CLI 配置无损保留及自定义端点必填地址测试。
- `npm run check`：0 错误、0 警告；`npm run build`：通过。
- macOS 本机 Chrome 模拟 IPC 浏览器流程：新增端点、发现模型、编辑能力和 max 映射、保存及离开草稿保护通过。临时浏览器配置已移除。
- 本次为前端与交互文档修改，未重新验证 Windows/Linux 原生环境。

## 尚待验收与已知限制

- Pi 1.4.0 的真实模型发送、真实 CLI 历史恢复、工具和扩展交互仍需使用者实机验收；模拟协议不等同于完整用户环境。
- macOS/Linux CI 已配置，尚未在远端执行，也未做对应实机验收。构建产物不签名、不公证。
- p95 启动≤2秒、增量可见≤100ms、分项/总内存基准尚未测完；没有宣称全部性能指标达标。
- 8MiB LRU 管理可重载正文，当前挂载窗口和流式内容除外；思考预览仍保留在内存，思考密集长历史可能超预算。
- 正常退出会删除临时文件；进程被外部强杀留下的私有临时目录尚无下次启动清扫机制。
- 配置原子保存与摘要索引已实现；窗口尺寸/侧栏折叠偏好尚未持久化。历史索引对“文件被替换但大小更大”的情况仍按追加处理。
- 超大记录、磁盘耗尽、超时乱序、Unix 进程组等需要更完整的故障注入测试；现有测试不覆盖计划列出的每一个边界。

架构和行为文档描述当前实现。以上条目保留为后续验收/完善项，避免把首版构建成功等同于全部计划验收完成。
