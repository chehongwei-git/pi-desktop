import { test, expect } from '@playwright/test';
for (const narrow of [false, true]) {
  test(`Skill 会话摘要 ${narrow ? '窄屏深色' : '宽屏浅色'}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: narrow ? 480 : 1200, height: 800 });
    await page.route('**/skill-title-fixture', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><html><body><main></main><script type="module" src="/tests/browser/skill-title-fixture.ts"></script></body></html>',
      }),
    );
    await page.goto('/skill-title-fixture');
    if (narrow)
      await page.evaluate(() => {
        document.documentElement.dataset.theme = 'dark';
      });
    const task = '请检查登录页面并修复窄窗口下按钮错位的问题';
    const button = page.getByRole('button', { name: task, exact: true });
    await expect(button).toBeVisible();
    await expect(button).toHaveAttribute('title', `${task}\n/project`);
    await button.focus();
    await expect(button).toBeFocused();
    await expect(
      page.getByRole('button', { name: '使用 ego-browser', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: '手动命名的会话', exact: true }),
    ).toBeVisible();
    expect(await page.locator('aside').textContent()).not.toContain('<skill');
    expect(await page.locator('aside').innerHTML()).not.toContain(
      '/Users/example',
    );
    const bounds = await page.locator('.session-text').first().boundingBox();
    expect(bounds!.width).toBeLessThan(288);
    await page.screenshot({
      path: `test-results/skill-title-${narrow ? 'narrow-dark' : 'wide-light'}.png`,
    });
  });
}
