/** 前端构建入口；固定本地端口供 Tauri 开发窗口连接，不启动业务 HTTP 服务。 */
import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
export default defineConfig({
  plugins: [svelte()],
  server: {
    port: 1420,
    strictPort: true,
    // 提前转换主页面依赖，避免首次浏览器用例与 Svelte 冷编译争用启动时间。
    warmup: { clientFiles: ['src/main.ts'] },
  },
  clearScreen: false,
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
    server: { deps: { inline: ['svelte'] } },
  },
  resolve: { conditions: ['browser'] },
});
