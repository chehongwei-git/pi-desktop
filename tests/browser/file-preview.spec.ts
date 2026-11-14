import { test, expect } from '@playwright/test';
for (const narrow of [false, true]) {
  test(`对话文件预览与系统打开 ${narrow ? '窄屏深色' : '宽屏浅色'}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: narrow ? 480 : 1280, height: 800 });
    await page.addInitScript(() => {
      (window as any).calls = [];
      (window as any).__TAURI_INTERNALS__ = {
        invoke: async (command: string, args: any) => {
          (window as any).calls.push({ command, args });
          if (command === 'open_message_file') return;
          if (command !== 'preview_file') throw new Error(command);
          if (args.path.includes('missing'))
            throw new Error('文件不存在，请检查路径');
          if (args.path.startsWith('../'))
            return {
              path: '/outside.txt',
              kind: 'approval',
              size: 0,
              canOpen: false,
            };
          if (args.path.endsWith('.md'))
            return {
              path: `/fixture-project/${args.path}`,
              kind: 'text',
              text: '# 文件预览说明\n\n留白让正文更容易阅读。\n\n- 保留上下文\n- 支持键盘\n\n| 名称 | 状态 |\n| --- | --- |\n| 预览 | 正常 |\n\n```ts\nconst message = "你好";\n```',
              size: 256,
              canOpen: true,
            };
          if (args.path.endsWith('.png'))
            return {
              path: '/fixture-project/assets/图.png',
              kind: 'image',
              image:
                'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1cAAAAASUVORK5CYII=',
              size: 68,
              canOpen: true,
            };
          if (args.path.endsWith('.pdf'))
            return {
              path: '/fixture-project/docs/报告.pdf',
              kind: 'other',
              size: 123,
              canOpen: true,
            };
          return {
            path: '/fixture-project/src/main.ts',
            kind: 'text',
            text: '第一行\n修改后的代码\n第三行',
            size: 50,
            canOpen: true,
          };
        },
      };
    });
    await page.route('**/file-preview-fixture', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><html><body><main></main><script type="module" src="/tests/browser/file-preview-fixture.ts"></script></body></html>',
      }),
    );
    await page.goto('/file-preview-fixture');
    if (narrow)
      await page.evaluate(
        () => (document.documentElement.dataset.theme = 'dark'),
      );
    const code = page.getByRole('link', { name: 'src/main.ts:2' });
    await code.click();
    await expect(
      page.getByRole('complementary', { name: '文件预览' }),
    ).toBeVisible();
    await expect(page.locator('.source-line.current')).toContainText(
      '修改后的代码',
    );
    await expect(
      page.getByText('磁盘当前内容 · 非历史快照', { exact: false }),
    ).toBeVisible();
    const panel = await page.locator('.file-preview-panel').boundingBox();
    expect(panel!.x).toBeGreaterThanOrEqual(0);
    expect(panel!.x + panel!.width).toBeLessThanOrEqual(narrow ? 480 : 1280);
    const source = await page.locator('.file-source').boundingBox();
    expect(source!.x - panel!.x).toBeGreaterThanOrEqual(16);
    expect(
      panel!.x + panel!.width - source!.x - source!.width,
    ).toBeGreaterThanOrEqual(16);
    await page.screenshot({
      path: `test-results/file-preview-${narrow ? 'narrow-dark' : 'wide-light'}.png`,
    });
    await page.getByRole('button', { name: '关闭预览' }).press('Escape');
    await expect(code).toBeFocused();
    await expect(page.getByRole('textbox', { name: '底部草稿' })).toHaveValue(
      '保留草稿',
    );
    await page.getByRole('link', { name: '报告', exact: true }).click();
    await page.getByRole('button', { name: '使用系统默认应用打开' }).click();
    expect(await page.evaluate(() => (window as any).calls.at(-1))).toEqual({
      command: 'open_message_file',
      args: {
        project: '/fixture-project',
        path: 'docs/报告.pdf',
        approved: false,
      },
    });
    await expect(page.locator('dialog')).toHaveCount(0);
    for (const [name, selector] of [
      ['说明', '.file-body > .markdown'],
      ['图片', '.file-image'],
      ['失败', '.file-notice.error-text'],
      ['项目外', '.file-notice'],
      ['长路径', '.file-body > .markdown'],
    ]) {
      await page.getByRole('button', { name: '关闭预览' }).click();
      await page.getByRole('link', { name, exact: true }).click();
      await expect(page.locator(selector).first()).toBeVisible();
      const bounds = await page.locator('.file-preview-panel').boundingBox();
      const item = await page.locator(selector).first().boundingBox();
      expect(item!.x - bounds!.x).toBeGreaterThanOrEqual(16);
      expect(
        bounds!.x + bounds!.width - item!.x - item!.width,
      ).toBeGreaterThanOrEqual(16);
      await page.screenshot({
        path: `test-results/file-preview-${name}-${narrow ? 'narrow-dark' : 'wide-light'}.png`,
      });
    }
    await page.evaluate(() => {
      document.documentElement.style.zoom = '1.5';
    });
    await expect(
      page.getByRole('button', { name: '关闭预览' }),
    ).toBeInViewport();
    const overflow = await page
      .locator('.file-preview-panel')
      .evaluate((node) => node.scrollWidth > node.clientWidth);
    expect(overflow).toBe(false);
  });
}
