/** 前端构建入口；固定本地端口供 Tauri 开发窗口连接，不启动业务 HTTP 服务。 */
import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
export default defineConfig(({ mode }) => ({
  plugins: [svelte()],
  // 独立端口仍会共享默认缓存；测试单独存储预构建，避免并发开发使动态导入失效。
  cacheDir:
    mode === 'browser-test' ? 'node_modules/.vite-browser-tests' : undefined,
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
}));
