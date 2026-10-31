import { test, expect } from '@playwright/test';

for (const short of [false, true]) {
  test(`automatic history handles ${short ? 'short pages to exhaustion' : 'delayed insertion and retry'}`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route(/\/history-fixture(?:\?short)?$/, (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><html><body><main style="height:100vh;display:flex;flex-direction:column"></main><script type="module" src="/tests/browser/history-fixture.ts"></script></body></html>',
      }),
    );
    await page.goto(`/history-fixture${short ? '?short' : ''}`);
    const root = page.locator('.transcript');
    if (short) {
      await expect
        .poll(() => page.evaluate(() => (window as any).calls))
        .toBe(4);
      await expect(root).toContainText('已到最早记录');
      await expect(page.locator('.message-item')).toHaveCount(5);
    } else {
      await expect(page.locator('.message-item')).toHaveCount(20);
      await root.evaluate((node) => {
        node.dispatchEvent(
          new WheelEvent('wheel', { deltaY: -100, bubbles: true }),
        );
        node.scrollTop = 180;
      });
      await expect
        .poll(() => page.evaluate(() => (window as any).calls))
        .toBe(1);
      // 请求中继续上翻；锚点必须使用提交时的位置，且不能重复请求。
      await root.evaluate((node) => {
        node.scrollTop = 60;
      });
      await page.waitForTimeout(100);
      expect(await page.evaluate(() => (window as any).calls)).toBe(1);
      await page.evaluate(() => (window as any).release());
      await expect(page.locator('.message-item')).toHaveCount(40);
      expect(
        await page.evaluate(() =>
          Math.abs(
            (window as any).anchor.getBoundingClientRect().top -
              (window as any).anchorTop,
          ),
        ),
      ).toBeLessThanOrEqual(1);
      await root.evaluate((node) => {
        node.scrollTop = 100;
      });
      await expect
        .poll(() => page.evaluate(() => (window as any).calls))
        .toBe(2);
      await page.evaluate(() => {
        (window as any).fail = true;
        (window as any).release();
      });
      await expect(root.getByRole('alert')).toContainText('模拟历史读取失败');
      await page.waitForTimeout(150);
      expect(await page.evaluate(() => (window as any).calls)).toBe(2);
      await page.evaluate(() => {
        (window as any).fail = false;
      });
      await root.getByRole('button', { name: '重试加载历史' }).click();
      await expect
        .poll(() => page.evaluate(() => (window as any).calls))
        .toBe(3);
      await page.evaluate(() => (window as any).release());
      await expect(page.locator('.message-item')).toHaveCount(60);
      await expect(root).toContainText('已到最早记录');
    }
    expect(errors).toEqual([]);
  });
}
