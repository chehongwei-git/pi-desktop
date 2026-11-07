# 原地编辑重发验证记录

## 实现范围

- 已确认用户消息使用铅笔图标入口；原地复用 DraftEditor、DraftAttachments。
- 编辑区仅取消／发送，辅助说明“从此处重新回答，文件不回退。”。
- 独立编辑快照保留底部草稿；运行与断线限制、组合输入保护、取消焦点恢复、未知提交禁止重试。
- 从当前分支定位历史起点并复用 Pi fork before 语义，保留原会话文件，不操作项目文件。
- 新增测试自动由现有 npm test、npm run test:browser 收录，不新增独立测试套件或绕过 CI。

## 最终版本实际执行

本机 macOS ARM64；全部命令退出码为 0。Cargo 初次因 PATH 缺少工具失败，定位已有工具链后使用 `export PATH="$HOME/.cargo/bin:$PATH"` 执行，未修改项目配置。

| 命令 | 结果 |
| --- | --- |
| npm run check | 0 错误、0 警告 |
| npm test | 53 文件、375 用例通过，0 失败 |
| node --test scripts/desktop.test.mjs | 3 通过、0 失败、0 跳过 |
| npm run test:browser | 101 通过、0 失败，包含新增 2 个编辑用例 |
| npm run build | 通过；主包约 551 kB，Vite 提示大于 500 kB 的非阻塞警告 |
| npx prettier --check src tests '*.ts' '*.js' '*.json' 'src-tauri/*.json' 'src-tauri/capabilities/*.json' | 全部匹配文件通过 |
| cargo fmt --manifest-path src-tauri/Cargo.toml --check | 通过 |
| cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings | 通过 |
| cargo test --manifest-path src-tauri/Cargo.toml --locked | 66 通过、0 失败、1 既有 ignored |
| cargo test --manifest-path src-tauri/Cargo.toml --locked platform::tests::installed_pi_starts_with_gui_path -- --ignored | 该既有忽略用例额外单独执行，1 通过 |

新增单元测试 9 个，包含完整正文／长粘贴／Windows 路径／分页图片恢复、元数据不一致拒绝、重复文字消息身份、图标入口、运行限制、扩展取消、未知提交、明确拒绝后复用分支。组件测试使用普通对象夹具时 Svelte 输出非响应式属性绑定提示；实际页面使用 Desktop 的深层响应式状态，并由浏览器输入后发送用例覆盖。

## 实际渲染

已查看浏览器截图：1200×800 浅色、480×800 深色。编辑区边界、文字、辅助说明及按钮均未越界，窄屏自动缩小；取消返回原铅笔入口，底部草稿保持不变。截图由测试输出至 test-results/message-edit-wide-light.png 与 test-results/message-edit-narrow-dark.png（生成产物，不纳入源码）。

## 未验证范围与限制

- 未完成 Windows、Linux 原生客户端运行、三平台原生打包或远程 CI；不能据此声明三平台原生验收通过。
- 编辑重发流程的自动化使用 mock IPC，未向真实模型发送请求；真实 Pi fork 语义已核对本机版本实现，但仍需原生端到端验收扩展钩子、真实历史与服务商响应。
- 当前编辑事务仅内存保存，不跨应用重启恢复；原会话保留在历史中，无额外分支树入口。
- 尚未单独验证新编辑区在系统输入法、高缩放、多附件长消息下的所有原生行为；后续按三平台真实任务验收，不以浏览器合成事件代替。
