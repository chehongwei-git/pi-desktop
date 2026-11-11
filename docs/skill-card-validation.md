# Skill 卡片验证记录

验证环境：本机 macOS。未执行 Windows、Linux CI 和三平台原生打包，不视为完成三平台发布验收。

最终代码版本执行结果：

| 命令 | 结果 |
| --- | --- |
| `npx prettier --check src tests *.ts *.js *.json src-tauri/*.json src-tauri/capabilities/*.json` | 全部匹配文件通过 |
| `npm run check` | 0 错误、0 警告 |
| `npm test` | 53 文件、377 用例通过，0 失败 |
| `node --test scripts/desktop.test.mjs` | 3 通过、0 失败、0 跳过 |
| `npm run test:browser` | 105 通过、0 失败 |
| `npm run build` | 通过；保留产物超过 500 kB 的体积警告，未关闭检查 |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --check` | 通过 |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings` | 通过 |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked` | 74 通过、0 失败、1 个既有 ignored |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked installed_pi_starts_with_gui_path -- --ignored` | 既有依赖本机 Pi 的忽略用例额外执行：1 通过 |

Cargo 初始不在 Shell PATH，后续在验证进程中补入本机工具链目录；未修改项目平台配置。

新增覆盖：宿主在截断前投影十万级 Unicode 技能说明、LF/CRLF、中文和 Windows 路径、实时及历史一致性、助手不折叠、异常包装回退；组件覆盖默认不读取说明、任务可见、Esc 收起和焦点恢复、复制与编辑恢复完整原文、读取失败重试。浏览器覆盖宽屏浅色与窄屏深色/125% 缩放，Enter 展开、Esc 收起及草稿保留。

初轮测试发现单元夹具未聚焦说明区，以及长名称在窄屏缩放下撑出父级边界；分别修正夹具焦点与 flex 子项收缩边界。截图复核又发现继承预留换行导致卡片额外增高，已将卡片恢复普通排版。上述修正后重新执行全部必需检查，非单独重跑。

实际查看截图：`test-results/skill-card-narrow-dark.png`、`test-results/skill-card-expanded-wide-light.png`；默认单行卡片、长名省略且完整名称保留在 title，任务正文独立可见，展开说明原地滚动。截图为浏览器夹具，不代替真实 Pi 会话和原生 WebView 验收。

## 正文引用失效回归修复

实际使用反馈 Skill 展开报“正文引用尚未恢复或历史已变化”。根因是新增的 `textParts[].skill.contentRef` 未纳入 `SessionContent.map` 的运行时所有权转换，而说明读取仍走严格句柄校验。修复统一覆盖绑定、相同内容重连重绑定、缓存保留及释放；不绕过校验，也不回退读取当前磁盘技能文件冒充历史正文。

新增单元回归验证嵌套说明与原包装各自绑定、重连后句柄稳定、旧运行时隔离、历史改变与淘汰后不可读取。浏览器夹具改为经过真实 `SessionContent.bind/retain/resolve` 路径后才返回正文，避免宽松 read mock 掩盖裸引用问题。修复版本重新执行上表全部命令，结果已更新；实际复核 `test-results/skill-card-expanded-narrow-dark.png`，说明正常显示，无引用错误。Windows、Linux 和真实原生会话恢复仍待对应环境验证。
