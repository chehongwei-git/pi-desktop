import { test, expect } from '@playwright/test';
for (const narrow of [false, true]) {
  test(`技能卡片按需展开 ${narrow ? '窄屏深色缩放' : '宽屏浅色'}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: narrow ? 480 : 1200, height: 800 });
    await page.route('**/skill-fixture', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><html><body><main></main><script type="module" src="/tests/browser/skill-fixture.ts"></script></body></html>',
      }),
    );
    await page.goto('/skill-fixture');
    if (narrow)
      await page.evaluate(() => {
        document.documentElement.dataset.theme = 'dark';
        document.documentElement.style.zoom = '1.25';
      });
    const trigger = page.getByRole('button', { name: /查看说明/ });
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(
      page.getByText('请将这份内容整理成 Word 文档，保留所有表格。'),
    ).toBeVisible();
    await expect(page.getByRole('region', { name: '技能说明' })).toHaveCount(0);
    const box = await trigger.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(narrow ? 480 : 1200);
    await page.screenshot({
      path: `test-results/skill-card-${narrow ? 'narrow-dark' : 'wide-light'}.png`,
    });
    await trigger.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('region', { name: '技能说明' })).toContainText(
      '保留标题层次与表格',
    );
    await page.screenshot({
      path: `test-results/skill-card-expanded-${narrow ? 'narrow-dark' : 'wide-light'}.png`,
    });
    await page.locator('.skill-body').focus();
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByRole('textbox', { name: '底部草稿' })).toHaveValue(
      '草稿保持不变',
    );
  });
}
