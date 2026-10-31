import { test, expect } from '@playwright/test';

for (const width of [1200, 600])
  test(`change panel preserves context and isolates reads at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route(/\/change-fixture$/, (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><html><body><main style="height:100vh;display:flex;flex-direction:column"></main><script type="module" src="/tests/browser/change-panel-fixture.ts"></script></body></html>',
      }),
    );
    await page.goto('/change-fixture');
    const root = page.locator('.transcript');
    const a = page.locator('.message-item[data-message-id="a"]');
    const b = page.locator('.message-item[data-message-id="b"]');
    await expect(a.locator('.tool-code')).toHaveCount(0);
    const button = a.getByRole('button', { name: '查看变更' });
    await button.scrollIntoViewIfNeeded();
    const top = await root.evaluate((node) => node.scrollTop);
    await button.click();
    const panel = page.getByRole('complementary', { name: '代码变更' });
    await expect(panel.getByRole('alert')).toContainText('模拟分页失败');
    await expect(panel).toContainText('new-a');
    await page.evaluate(() => {
      (window as any).fail = false;
    });
    await panel.getByRole('button', { name: '重试读取变更' }).click();
    await expect(panel).toContainText('tail-a-399');
    await expect(panel.locator('.tool-code-line')).toHaveCount(402);
    await panel.locator('.change-panel-body').evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    await expect(
      panel.getByText('+401 tail-a-399', { exact: true }),
    ).toBeInViewport();
    await panel.getByRole('button', { name: '关闭变更' }).click();
    await expect(button).toBeFocused();
    expect(
      Math.abs((await root.evaluate((node) => node.scrollTop)) - top),
    ).toBeLessThanOrEqual(1);
    await page.evaluate(() => {
      (window as any).slow = true;
    });
    await button.click();
    await expect(panel).toContainText('正在读取');
    if (width <= 900)
      await panel.getByRole('button', { name: '关闭变更' }).click();
    await b.getByRole('button', { name: '查看变更' }).click();
    await expect(panel).toContainText('tail-b-399');
    await page.evaluate(() => (window as any).release());
    await expect(panel).not.toContainText('new-a');
    await panel.getByRole('button', { name: '关闭变更' }).press('Escape');
    await expect(b.getByRole('button', { name: '查看变更' })).toBeFocused();
    expect(errors).toEqual([]);
  });
