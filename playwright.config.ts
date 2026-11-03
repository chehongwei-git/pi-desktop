/** Windows 使用系统 Edge，macOS/Linux 使用 Playwright Chromium；只模拟 IPC，不模拟 Svelte/DOM。 */
import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'tests/browser',
  fullyParallel: false,
  // fullyParallel=false 仍会并行执行不同文件。CI 串行隔离重型滚动采样与页面加载，
  // 避免有限 runner 资源争用；Windows trace 已记录模块请求 ERR_NO_BUFFER_SPACE。
  workers: process.env.CI ? 1 : undefined,
  timeout: 30000,
  use: {
    baseURL: 'http://127.0.0.1:1420',
    headless: true,
    // 失败保留网络、页面异常与截图，区分模块加载超时和真实交互错误。
    // 长输出滚动用例含大量 DOM；逐操作快照会显著干扰测量，保留事件/网络而不采集 DOM 快照。
    trace: { mode: 'retain-on-failure', snapshots: false, screenshots: false },
    screenshot: 'only-on-failure',
    viewport: { width: 1200, height: 800 },
    ...(process.platform === 'win32' ? { channel: 'msedge' } : {}),
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:1420',
    reuseExistingServer: !process.env.CI,
  },
});
