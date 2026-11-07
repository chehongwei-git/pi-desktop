import { test, expect } from '@playwright/test';

for (const width of [1200, 480]) {
  test(`精简差异原地展开、导航与收起 ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.route('**/compact-diff-fixture', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><html><head><meta charset="utf-8"></head><body><main style="height:100vh;display:flex;flex-direction:column"></main><script type="module" src="/tests/browser/compact-diff-fixture.ts"></script></body></html>',
      }),
    );
    await page.goto('/compact-diff-fixture');
    const panel = page.getByRole('complementary', { name: '代码变更' });
    await expect(panel).toContainText('精简差异 · 2 处修改');
    await expect(panel.getByText(' 58 keep-58', { exact: true })).toBeVisible();
    await expect(panel.getByText(' 57 keep-57', { exact: true })).toHaveCount(
      0,
    );
    await expect(panel.getByText('-61 old', { exact: true })).toBeVisible();
    await expect(panel.getByText('+61 new', { exact: true })).toBeVisible();
    const fold = panel.getByRole('button', { name: /已隐藏 57 行/ }).first();
    await fold.focus();
    await fold.press('Enter');
    await expect(
      panel.getByRole('button', { name: /已隐藏 37 行/ }),
    ).toBeFocused();
    await expect(panel.getByText(' 38 keep-38', { exact: true })).toBeVisible();
    await panel.getByRole('button', { name: '收起此段上下文' }).click();
    await expect(fold).toBeFocused();
    await panel.getByRole('button', { name: '下一处修改' }).click();
    await panel.getByRole('button', { name: '下一处修改' }).click();
    await expect(
      panel.getByText('-122 before', { exact: true }),
    ).toBeInViewport();
    await expect(
      panel.getByRole('button', { name: '下一处修改' }),
    ).toBeDisabled();
    await panel.getByRole('button', { name: '上一处修改' }).click();
    await expect(panel.getByText('-61 old', { exact: true })).toBeInViewport();
    await panel.getByRole('button', { name: '展开全部上下文' }).click();
    await expect(panel.locator('.tool-code-line')).toHaveCount(184);
    await panel.getByRole('button', { name: '收起未修改代码' }).click();
    await expect(panel.getByText(' 1 keep-1', { exact: true })).toHaveCount(0);
    await page.screenshot({
      path: `test-results/compact-diff-${width}-light.png`,
    });
    await page.evaluate(
      () => (document.documentElement.dataset.theme = 'dark'),
    );
    await page.screenshot({
      path: `test-results/compact-diff-${width}-dark.png`,
    });
    expect(await panel.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
      true,
    );
  });
}
