import { test, expect } from '@playwright/test';

for (const width of [1200, 480]) {
  test(`unified process hides details, retains answer and restores focus at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/process-fixture', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><html><body><main style="height:100vh;display:flex;flex-direction:column"></main><script type="module" src="/tests/browser/process-fixture.ts"></script></body></html>',
      }),
    );
    await page.goto('/process-fixture');
    const heading = page.locator('.process-heading');
    await expect(heading).toHaveCount(1);
    await expect(page.locator('[data-message-id="blank"]')).toHaveCount(0);
    await expect(heading).toContainText('耗时 23 秒');
    await expect(heading).toContainText('1 次工具调用');
    await expect(heading).toHaveAttribute('aria-expanded', 'false');
    await expect(
      page.getByText('检查完成，没有发现问题。', { exact: true }),
    ).toBeVisible();
    await expect(page.getByText('我先检查文件', { exact: true })).toBeVisible();
    await expect(heading).not.toContainText('有步骤失败');
    await heading.focus();
    await heading.press('Enter');
    await expect(page.getByText('我先检查文件', { exact: true })).toBeVisible();
    await expect(
      page.getByText('先确认文件内容，再判断结果。', { exact: true }),
    ).toBeVisible();
    await expect(page.locator('.tool-expanded')).toHaveCount(0);
    await page.getByRole('button', { name: /read.*查看详情/ }).click();
    await expect(page.getByText('文件内容', { exact: true })).toBeVisible();
    await page
      .getByRole('button', { name: '收起处理过程', exact: true })
      .press('Escape');
    await expect(heading).toBeFocused();
    await expect(heading).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('.tool-expanded')).toHaveCount(0);
    await heading.click();
    await expect(page.getByText('文件内容', { exact: true })).toBeVisible();
    const originalHeading = await heading.elementHandle();
    await page
      .getByRole('button', { name: '追加过程内容', exact: true })
      .click();
    await page
      .getByRole('button', { name: '补载同组历史', exact: true })
      .click();
    await expect(heading).toHaveCount(1);
    await expect(heading).toHaveAttribute('aria-expanded', 'true');
    await expect(heading).toContainText('3 次工具调用');
    await expect(
      page.getByText('继续核对结果。', { exact: true }),
    ).toBeVisible();
    await expect(page.getByText('文件内容', { exact: true })).toBeVisible();
    expect(
      await originalHeading!.evaluate(
        (node) => node === document.querySelector('.process-heading'),
      ),
    ).toBe(true);
    expect(
      await page
        .locator('.process-content [data-message-id]')
        .evaluateAll((nodes) =>
          nodes.map((node) => node.getAttribute('data-message-id')),
        ),
    ).toEqual(['read-older', 'read', 'more-thinking', 'read-next', 'answer']);
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'dark';
    });
    await page.screenshot({ path: `test-results/process-${width}-dark.png` });
    expect(errors).toEqual([]);
  });
}
