import { test, expect } from '@playwright/test';
test('sent file cards keep paths accessible in light and narrow dark layouts', async ({
  page,
}) => {
  await page.route('**/sent-files-fixture', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><body><main></main><script type="module" src="/tests/browser/sent-files-fixture.ts"></script></body></html>',
    }),
  );
  await page.goto('/sent-files-fixture');
  const card = page.getByRole('button', { name: /查看文件引用：非常长/ });
  await expect(card).toBeVisible();
  await expect(
    page.getByRole('button', { name: '展开其余 1 项' }),
  ).toBeVisible();
  await card.click();
  await expect(
    page.getByRole('region', { name: '文件引用详情' }),
  ).toContainText('/project/设计资料/');
  await page.screenshot({
    path: 'test-results/sent-files-light.png',
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 480, height: 1000 });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
  });
  const box = (await page
    .getByRole('region', { name: '文件引用详情' })
    .boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(480);
  await page.screenshot({
    path: 'test-results/sent-files-dark-narrow.png',
    animations: 'disabled',
  });
  await page.getByRole('button', { name: '收起文件详情' }).press('Escape');
  await expect(card).toBeFocused();
  await page.getByRole('button', { name: '展开其余 1 项' }).click();
  await expect(
    page.getByRole('button', { name: '查看文件引用：extra.txt' }),
  ).toBeVisible();
  await page.getByRole('button', { name: '查看原文' }).click();
  await expect(page.locator('.message.user')).toContainText('文件引用：');
  await page.getByRole('button', { name: '返回卡片' }).click();
  await expect(card).toBeVisible();
});
