/** 浏览器验收复用系统 Edge（Windows）；CI 使用 Playwright 的 Chromium。只模拟 IPC，不模拟 Svelte/DOM。 */
import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'tests/browser',
  globalSetup: './tests/browser/setup.ts',
  fullyParallel: false,
  timeout: 30000,
  use: {
    baseURL: 'http://127.0.0.1:1421',
    headless: true,
    viewport: { width: 1200, height: 800 },
    ...(process.platform === 'win32' ? { channel: 'msedge' } : {}),
  },
  webServer: {
    // 测试不复用桌面开发实例，防止依赖预构建和热更新污染另一方的页面。
    command: 'npm run dev -- --port 1421 --mode browser-test',
    url: 'http://127.0.0.1:1421',
    reuseExistingServer: false,
  },
});
