# 文件与图片附件验证记录

范围：统一文件选择与原生文件拖放、图片／路径引用卡片、发送与草稿恢复，以及 Windows 原生拖放开启后的内部排序和文字拖动兼容。

环境：Windows x64，Node.js 24.13.0，Rust 1.93.1，Playwright 使用系统 Edge。浏览器仅替换宿主 IPC，使用实际 Svelte、DOM、文件读取与鼠标／键盘事件；未调用在线生成模型。

## 最终版本检查

以下命令在最后一次代码和测试修改后完整执行。浏览器使用已有 CI 单 worker 配置；Rust 设置进程级 `CARGO_INCREMENTAL=0`，只关闭本机增量缓存，不关闭编译或 Clippy 检查。

| 实际命令                                                                                                                                                               | 结果                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `npm run check`                                                                                                                                                        | 0 错误、0 警告                                                       |
| `npm test`                                                                                                                                                             | 46 个测试文件，351 项通过，0 失败、0 忽略                            |
| `node --test scripts/desktop.test.mjs`                                                                                                                                 | 3 项通过，0 失败、0 跳过                                             |
| `node node_modules/prettier/bin/prettier.cjs --check src tests "*.ts" "*.js" "*.json" "src-tauri/*.json" "src-tauri/capabilities/*.json" src-tauri/bridge/desktop.mjs` | 通过                                                                 |
| `npm run build`                                                                                                                                                        | 通过                                                                 |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --check`                                                                                                               | 通过                                                                 |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings`                                                                              | 通过                                                                 |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked`                                                                                                             | 60 项通过，0 失败，1 项既有环境依赖测试忽略；主程序与文档测试各 0 项 |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked platform::tests::installed_pi_starts_with_gui_path -- --ignored --exact`                                     | 上述忽略项单独执行：1 项通过，0 失败、0 忽略                         |
| `CI=true npm run test:browser`                                                                                                                                         | 全量 93 项通过，0 失败、0 跳过                                       |
| `git diff --check`                                                                                                                                                     | 通过                                                                 |

完整命令、退出码、耗时和输出保存在本机临时目录 `pi-file-import-final-verification/` 的 `status.json` 与各项 `.log`。新增用例由既有 Vitest、Playwright、Cargo 测试入口自动收集；CI 补齐了桌面脚本测试和全量 Prettier 检查。

## 覆盖与视觉检查

- 混合文件分类及顺序、部分失败保留成功项、图片格式签名／数量／大小预算、重复图片的独立实例、普通文件与目录只引用路径。
- 一次性拖入票据的窗口绑定、过期、替换和消费；可见输入框路由、物理坐标换算、异步监听清理、上下文切换后忽略迟到导入。
- JSON 路径转义及中文／空格／换行、长粘贴文本范围、首条和普通消息、steer／followUp、发送失败及发送中继续编辑、停止恢复、v1/v2 草稿兼容和图片数据不落盘。
- 文件详情的复制／编辑／移除、Escape 和焦点恢复、无可信路径时不伪造引用；失败后保留草稿，等待最新快照持久化后刷新恢复路径。
- 侧栏鼠标和 Alt+方向键排序；普通文字在 100%／200% 缩放下指针移动、取消、撤销；长粘贴卡片移动保留身份、全文和撤销事务，复制使用新卡片身份。
- 已实际打开检查浅色 1200px、深色 480px 窄窗口与 200% 缩放截图：文件名和扩展名、次级目录、移除按钮、内联路径详情及发送控件没有意外越界。横向附件条允许部分露出下一张卡片并滚动查看。截图为 `test-results/file-attachments-light.png`、`file-attachments-dark-narrow.png`、`file-attachments-dark-zoom.png`。

## 排查记录

- 修正新增 Clippy 布尔表达式告警。全量格式检查发现 38 个既有文件的换行问题，统一工作区换行；未为此引入额外业务变更，保留用户对 `AGENTS.md` 的修改。
- 修正浏览器用例误用组件断言 API、恢复测试过早刷新和缩放用例固定像素落点。保留并加强原有行为断言，没有增加 skip、重试或放宽断言。
- 一轮既有侧栏回归超时：trace 显示首次 `page.goto` 耗时约 28.2 秒，而后重命名、归档操作正常；该时间段与额外 Rust 编译重叠。最终检查严格串行执行，避免重型编译与浏览器回归争用资源，没有提高测试超时或修改该用例断言。
- 本机 Rust 增量缓存写入出现 Windows `os error 5` 告警。改用进程级 `CARGO_INCREMENTAL=0` 后重新执行完整 Rust 格式、Clippy、测试及安装冒烟，均成功且不再出现该缓存告警；没有修改系统全局环境或关闭静态检查。

## 尚待验证

- Windows、macOS、Linux 三个平台的真实系统文件选择／拖入、不同 DPI 与多屏、原生中文输入法和系统剪贴板；浏览器原生事件模拟不能替代这些验收。
- macOS／Linux 实机和三平台远端 CI、原生安装包及发布验收。
- 完整 WCAG 2.2 AA 审核；当前只验证相关语义、键盘、焦点及布局，不声明完整标准符合性。

状态：实现已落地，Windows 本机最终版本的全部必需自动化检查已通过；三平台原生交互和发布验收仍待验证，不宣称三平台验收或发布完成。
