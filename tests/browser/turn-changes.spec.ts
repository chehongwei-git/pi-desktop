/** 独立审阅列不得受文件列表和输入区高度影响；窄屏保留页面上下文。 */
import { test, expect } from '@playwright/test';
test('review keeps full height when the file list or composer grows', async ({
  page,
}) => {
  await page.route('**/turn-changes-fixture', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><head><meta charset="utf-8"></head><body><main></main><script type="module" src="/tests/browser/turn-changes-fixture.ts"></script></body></html>',
    }),
  );
  await page.goto('/turn-changes-fixture');
  const left = page.locator('.review-conversation');
  const toggle = left.getByRole('button', { name: /代码变更/ });
  await toggle.click();
  const file = left.getByRole('button', { name: /App.svelte/ });
  await file.click();
  const panel = page.getByRole('complementary', {
    name: '代码变更',
    exact: true,
  });
  await expect(panel.getByRole('region', { name: '代码差异' })).toContainText(
    'const value = 2;',
  );
  const details = page.locator('.review-details');
  // 结构与几何同时约束，防止以后再次把文件选择插入代码审阅区域。
  await expect(
    details.locator('.turn-changes, .changes-list, .round-trigger'),
  ).toHaveCount(0);
  await expect(page.locator('.turn-changes')).toHaveCount(1);
  const before = await panel.boundingBox();
  const listBounds = await left.locator('.changes-list').boundingBox();
  expect(listBounds!.x + listBounds!.width).toBeLessThanOrEqual(before!.x);
  await left.getByRole('button', { name: '采集范围与说明' }).click();
  expect(await panel.boundingBox()).toEqual(before);
  await left.getByRole('button', { name: '采集范围与说明' }).click();
  await left.getByRole('button', { name: '选择变更轮次' }).click();
  const menuBounds = await left.locator('.round-menu').boundingBox();
  expect(menuBounds!.x + menuBounds!.width).toBeLessThanOrEqual(before!.x);
  expect(await panel.boundingBox()).toEqual(before);
  await left.locator('.round-menu').press('Escape');
  await toggle.click();
  await expect
    .poll(async () => (await panel.boundingBox())?.height)
    .toBe(before!.height);
  await left
    .getByLabel('消息输入')
    .evaluate((node) => (node.style.height = '190px'));
  expect(await panel.boundingBox()).toEqual(before);
  await toggle.click();
  await expect(file).toHaveAttribute('aria-pressed', 'true');
  await page.screenshot({ path: 'test-results/review-layout-light.png' });
  await panel.getByRole('button', { name: '关闭变更' }).press('Escape');
  await expect(file).toBeFocused();
  await expect(file).toHaveAttribute('aria-pressed', 'false');
  await page.setViewportSize({ width: 480, height: 800 });
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  await file.click();
  await expect(page.getByRole('button', { name: '返回对话' })).toBeVisible();
  await expect(page.getByRole('button', { name: '切换文件' })).toHaveCount(0);
  await expect(
    details.locator('.turn-changes, .changes-list, .round-trigger'),
  ).toHaveCount(0);
  await page.screenshot({ path: 'test-results/review-layout-dark-narrow.png' });
  await page.getByRole('button', { name: '返回对话' }).click();
  await expect(left.getByLabel('消息输入')).toHaveValue('继续调整');
  await expect(file).toBeFocused();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  // 返回原清单再次打开，不需要也不允许在代码区生成第二份清单。
  await file.click();
  await expect(panel).toBeVisible();
  await expect(details.locator('.turn-changes')).toHaveCount(0);
});
