# 轮次跟随与计划进度生命周期验证

验证环境：macOS arm64；浏览器为 Playwright Chromium。Windows、Linux CI 与三平台原生打包尚未执行，发布验证仍待完成。

## 行为覆盖

- 历史轮次查看期间，同轮刷新保留选择；新轮次生成自动回到最近一轮，保留展开状态并清除旧选中。
- 自动关闭旧轮次差异不抢占输入焦点，普通用户关闭仍恢复文件入口。
- 已完成计划暂留，下一条消息成功提交后隐藏；重复完成通知不复活卡片，扩展发布新计划后正常展示。
- 发送失败、迟到的其他会话回执、未完成/受限/未知步骤、本地命令及提交期间重建计划均有回归覆盖。
- 宽屏浅色、窄屏深色截图已检查；未发现本次修改导致的拥挤、越界或截断。

## 最终版本验证结果

| 命令 | 结果 |
| --- | --- |
| `npm run check` | 0 错误、0 警告 |
| `npm test` | 49 文件，362 通过、0 失败、0 忽略 |
| `node --test scripts/desktop.test.mjs` | 3 通过、0 失败、0 忽略 |
| `npm run test:browser` | 97 通过、0 失败、0 忽略 |
| `npm run build` | 通过；保留大于 500 kB 的构建分块提示 |
| `npx prettier --check src tests "*.ts" "*.js" "*.json" "src-tauri/*.json" "src-tauri/capabilities/*.json" src-tauri/bridge/desktop.mjs` | 通过 |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --check` | 通过 |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings` | 通过 |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked` | 66 通过、0 失败、1 既有忽略 |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked platform::tests::installed_pi_starts_with_gui_path -- --ignored` | 1 通过、0 失败；以最小系统 PATH 加 Cargo 工具目录单独运行既有真实 Pi 探测 |
| `git diff --check` | 通过 |

Cargo 初次调用因工具目录不在 PATH 而未执行，补充当前用户 Cargo 工具目录后已运行上述检查。既有忽略项需要真实本机 Pi，已按其说明单独执行成功；未删除或修改忽略标记。

首轮新增用例暴露测试 matcher/夹具问题，以及自动关闭面板的焦点竞争；修正后重新执行完整清单全部通过，并非以单用例重跑替代全量验证。

测试截图：`test-results/plan-card-light.png`、`test-results/plan-card-dark-narrow.png`、`test-results/review-layout-light.png`、`test-results/review-layout-dark-narrow.png`（测试产物，不纳入源码提交）。

限制：扩展协议没有计划唯一 ID；相同已完成步骤的重复推送按旧计划处理。新计划可通过清空、未完成步骤或不同步骤内容区分，桌面不推测自然语言中的计划身份。
