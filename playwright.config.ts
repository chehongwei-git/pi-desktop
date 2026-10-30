/** 浏览器验收复用系统 Edge（Windows）；CI 使用 Playwright 的 Chromium。只模拟 IPC，不模拟 Svelte/DOM。 */
import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'tests/browser',
  fullyParallel: false,
  timeout: 30000,
  use: {
    baseURL: 'http://127.0.0.1:1420',
    headless: true,
    viewport: { width: 1200, height: 800 },
    ...(process.platform === 'win32' ? { channel: 'msedge' } : {}),
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:1420',
    reuseExistingServer: !process.env.CI,
  },
});
