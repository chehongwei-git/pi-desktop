# 管理页面按需加载与分包验证

## 变更及体积

- 设置、插件管理使用动态 import，仅打开时加载页面脚本和样式。
- LazyPage 提供原内容区加载、返回、Escape、失败显式重试；卸载后不渲染迟到结果。实际页面继续负责未保存保护、标题焦点与返回入口恢复。
- markdown-it、DOMPurify 及其 Rollup 归并依赖形成 markdown-vendor，同步可用；高亮仍沿用动态加载，不调高 500 kB 警告阈值。
- 同一 macOS 环境 `npm run build` 基线：主 JS 595.33 kB / gzip 211.10 kB，CSS 104.34 kB / gzip 18.83 kB。
- 最终构建：主 JS 380.36 kB / gzip 125.51 kB，Markdown 135.80 kB / gzip 58.36 kB；启动同步 JS 合计约 516.16 kB / gzip 183.87 kB，相比基线减少约 13.3% / 12.9%。启动 CSS 72.46 kB / gzip 13.68 kB。
- 按需页面 JS：设置 40.74 kB，插件 35.16 kB，共享 SettingsSelect 5.80 kB。设置与插件各自样式亦单独输出。
- 最终构建没有超大 chunk 警告。减少主包不等于同幅度减少启动总量；未测量原生启动耗时，不宣称启动提速比例。

## 最终代码版本验证（macOS）

| 命令 | 结果 |
| --- | --- |
| `npm run check` | 0 错误、0 警告 |
| `npm test` | 60 文件、428 测试通过，0 失败 |
| `node --test scripts/desktop.test.mjs` | 3 通过，0 失败、0 跳过 |
| `npm run test:browser -- --workers=1` | 117 通过，0 失败、0 跳过 |
| `npm run build` | 通过，无 chunk 大小警告 |
| `npx prettier --check src tests "*.ts" "*.js" "*.json" "src-tauri/*.json" "src-tauri/capabilities/*.json"` | 全部匹配文件通过 |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --check` | 通过 |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings` | 通过 |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked` | 89 通过、0 失败、1 个既有忽略；main/doc tests 为 0 |
| `git diff --check` | 通过 |

Cargo 初次未在默认 PATH 中找到，随后将本机用户目录的 .cargo/bin 加入 PATH，成功执行上述三个检查；未修改项目工具链配置。

单元测试保留既有 MessageEdit 夹具的两条 non-reactive binding 运行时提示，不来自本次变更；svelte-check 无警告。

新增 LazyPage 组件测试随现有 `npm test` 自动收集；新增 lazy-pages.spec.ts 随现有浏览器套件收集，不增加独立 CI 套件。覆盖等待期间返回、迟到结果不重新打开、首次打开才请求模块、再次打开复用模块、草稿保留、焦点恢复，以及组件层失败显式重试。已有设置和插件全量回归继续覆盖未保存保护。

首次完整浏览器执行暴露真实回归：原快捷键用例在设置占位可见后立即 Escape，加载期间没有返回处理。补齐占位 Escape 处理及组件回归后，最终版本重新完整执行全部检查和 117 个浏览器测试通过。没有删除、跳过或弱化原用例。

截图输出位于 test-results/lazy-page-loading.png、test-results/lazy-page-settings.png；检查加载布局无拥挤或意外截断。截图是浏览器 mock IPC，不代表原生 WebView 验收。

## 未验证范围 / 状态

- Rust 既有 `platform::tests::installed_pi_starts_with_gui_path` 标注忽略，需要本机真实 Pi 安装并在最小 PATH 下单独执行；本次没有修改或新增 ignore，未将该项计为通过。
- Windows、Linux CI 与 Windows/macOS/Linux 原生打包未执行，需要对应平台 CI 和原生验收。
- 因上述范围未验证，本次状态为**本机自动化通过，跨平台发布待验证**，不宣称全部测试零忽略或三平台发布完成。
