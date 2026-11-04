/** 冷启动属于环境准备：先完成模块编译，正式用例仍使用各自的超时和独立上下文。 */
import { chromium, type FullConfig } from '@playwright/test';
export default async function prepareBrowser(
  config: FullConfig,
): Promise<void> {
  const use = config.projects[0].use;
  const browser = await chromium.launch({
    channel: use.channel,
    headless: true,
  });
  try {
    const page = await browser.newPage();
    // 不安装 Tauri 端口，不会启动 Pi；这里只等待应用模块加载。
    await page.goto(use.baseURL!, {
      waitUntil: 'networkidle',
      timeout: 120000,
    });
    const highlighted = await page.evaluate(async () => {
      const path = '/src/lib/tool-presentation.ts';
      const { colorCode } = await import(path);
      return colorCode('const ready = true;', 'typescript');
    });
    if (!highlighted.includes('hljs-keyword'))
      throw new Error('浏览器测试依赖尚未就绪：TypeScript 高亮不可用');
  } finally {
    await browser.close();
  }
}
