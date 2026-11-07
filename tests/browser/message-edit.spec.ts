import { test, expect } from '@playwright/test';
for (const narrow of [false, true]) {
  test(`原地编辑、取消与分支重发 ${narrow ? '窄屏深色' : '宽屏浅色'}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: narrow ? 480 : 1200, height: 800 });
    await page.route('**/edit-fixture', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><html><body><main></main><script type="module" src="/tests/browser/edit-fixture.ts"></script></body></html>',
      }),
    );
    await page.goto('/edit-fixture');
    if (narrow)
      await page.evaluate(
        () => (document.documentElement.dataset.theme = 'dark'),
      );
    const trigger = page.getByRole('button', { name: '编辑并重发' }).first();
    await trigger.click();
    const input = page.getByRole('textbox', { name: '编辑消息内容' });
    await expect(input).toBeFocused();
    await expect(
      page.getByRole('button', { name: '发送', exact: true }),
    ).toBeVisible();
    await expect(page.getByText('从此处重新回答，文件不回退。')).toBeVisible();
    await expect(page.getByRole('textbox', { name: '底部草稿' })).toHaveValue(
      '不要覆盖我的草稿',
    );
    const box = await page.locator('.inline-message-edit').boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(narrow ? 480 : 1200);
    await page.screenshot({
      path: `test-results/message-edit-${narrow ? 'narrow-dark' : 'wide-light'}.png`,
    });
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await expect(trigger).toBeFocused();
    await trigger.click();
    await input.fill('修改后的消息');
    await page.evaluate(() => (window as any).setRunning(true));
    await expect(
      page.getByRole('button', { name: '发送', exact: true }),
    ).toBeDisabled();
    await page.evaluate(() => (window as any).setRunning(false));
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(page.getByText('这是重新生成的回答。')).toBeVisible();
    await expect(page.getByText('修改后的消息', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => (window as any).sent)).toEqual([
      '修改后的消息',
    ]);
    await expect(page.getByRole('textbox', { name: '底部草稿' })).toHaveValue(
      '不要覆盖我的草稿',
    );
  });
}
