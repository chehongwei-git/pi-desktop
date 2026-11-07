import { test, expect } from '@playwright/test';

for (const narrow of [false, true]) {
  test(`消息目录独立分页与历史定位 ${narrow ? '窄窗口' : '宽窗口'}`, async ({
    page,
  }) => {
    if (narrow) await page.setViewportSize({ width: 480, height: 720 });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/navigator-fixture', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><html><body><main></main><script type="module" src="/tests/browser/navigator-fixture.ts"></script></body></html>',
      }),
    );
    await page.goto('/navigator-fixture');
    const transcript = page.getByRole('region', { name: '对话消息' });
    await expect(page.locator('.message-item')).toHaveCount(20);
    const before = await transcript.evaluate((node) => node.scrollTop);
    const bounds = await transcript.boundingBox();
    await page.getByRole('button', { name: '我的消息', exact: true }).click();
    await expect(
      page.getByRole('textbox', { name: '搜索已加载消息摘要' }),
    ).toBeFocused();
    expect(await transcript.boundingBox()).toEqual(bounds);
    expect(await transcript.evaluate((node) => node.scrollTop)).toBe(before);
    await page.evaluate(() => {
      (window as any).failDirectory = true;
    });
    await page.getByRole('button', { name: '加载更早消息' }).click();
    await expect(page.getByRole('alert')).toContainText('目录读取失败');
    await page.evaluate(() => {
      (window as any).failDirectory = false;
    });
    await page.getByRole('button', { name: '重试加载目录' }).click();
    await expect(page.locator('.navigator-item')).toHaveCount(20);
    await expect(page.locator('.message-item')).toHaveCount(20);
    expect(await page.evaluate(() => (window as any).bodyCalls)).toBe(0);
    const search = page.getByRole('textbox', { name: '搜索已加载消息摘要' });
    await search.fill('消息 0 ');
    await expect(page.locator('.navigator-item')).toHaveCount(1);
    await page.evaluate(() => {
      (window as any).delayBody = true;
    });
    await page.locator('.navigator-item').click();
    await expect(page.getByText('正在定位历史消息…')).toBeVisible();
    await page.getByRole('button', { name: '取消定位' }).click();
    await page.evaluate(() => (window as any).releaseBody());
    await expect(page.locator('.message-item')).toHaveCount(40);
    await expect(page.locator('.navigation-target')).toHaveCount(0);
    await page.locator('.navigator-item').click();
    const target = page.locator('[data-message-id="nav-0"]');
    await expect(target).toBeFocused();
    await expect(target).toHaveClass(/navigation-target/);
    await expect(page.locator('.message-item')).toHaveCount(40);
    await expect(page.getByRole('textbox', { name: '草稿' })).toHaveValue(
      '保留我的草稿',
    );
    await expect(
      page.getByRole('navigation', { name: '我的消息目录' }),
    ).toBeVisible({ visible: !narrow });
    await page.evaluate(() => (window as any).append());
    await expect(page.locator('.message-item')).toHaveCount(42);
    expect(await transcript.evaluate((node) => node.scrollTop)).toBeLessThan(
      100,
    );
    await expect(page.getByRole('button', { name: '回到底部' })).toBeVisible();
    if (narrow)
      await page.getByRole('button', { name: '我的消息', exact: true }).click();
    await search.fill('');
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'dark';
    });
    await page.screenshot({
      path: `test-results/message-navigator-open-${narrow ? 'narrow' : 'wide'}.png`,
    });
    await search.fill('不存在的摘要');
    await expect(page.getByText('已加载摘要中没有匹配消息')).toBeVisible();
    await search.press('Escape');
    await expect(
      page.getByRole('button', { name: '我的消息', exact: true }),
    ).toBeFocused();
    await expect(
      page.getByRole('navigation', { name: '我的消息目录' }),
    ).toHaveCount(0);
    expect(errors).toEqual([]);
    await page.screenshot({
      path: `test-results/message-navigator-${narrow ? 'narrow' : 'wide'}.png`,
    });
  });
}
