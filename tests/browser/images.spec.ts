/** 浏览器验收真实 FileReader、WebCrypto 和图片预览；IPC 不调用在线模型。 */
import { test, expect } from '@playwright/test';
test('sends multiple images without text, renders history and preserves failed drafts', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const host = window as any;
    host.sent = [];
    host.__TAURI_INTERNALS__ = {
      transformCallback: () => 1,
      unregisterCallback: () => {},
      async invoke(command: string, args: any = {}) {
        const model = {
          id: 'vision',
          provider: 'test',
          name: 'Vision',
          input: ['text', 'image'],
        };
        if (command === 'get_settings')
          return {
            theme: 'light',
            zoom: 100,
            recentProjects: [],
            pinnedSessions: [],
            projectOrder: [],
            extraPath: [],
          };
        if (command === 'save_settings') return;
        if (command === 'list_sessions') return [];
        if (command === 'connect_pi')
          return {
            runtimeId: 'r',
            project: '/test',
            version: '1.4.0',
            verified: true,
            snapshot: { model, sessionFile: 's' },
          };
        if (command === 'read_content')
          return {
            text: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1sAAAAASUVORK5CYII=',
            next: 92,
            done: true,
          };
        if (command === 'perform') {
          switch (args.action.type) {
            case 'models':
              return { models: [model] };
            case 'commands':
              return { commands: [] };
            case 'thinking_levels':
              return { levels: ['off'] };
            case 'state':
              return { model, sessionFile: 's' };
            case 'history':
              return {
                messages: [
                  {
                    id: 'history',
                    role: 'user',
                    text: '',
                    thinking: '',
                    status: 'done',
                    name: null,
                    contentRef: null,
                    images: [
                      {
                        id: 'history-image',
                        mimeType: 'image/png',
                        contentRef: 'image-body',
                      },
                    ],
                  },
                ],
                before: 0,
                hasMore: false,
              };
            case 'prompt':
              host.sent.push(args.action);
              if (host.failSend) throw new Error('发送失败');
              return {};
            default:
              return {};
          }
        }
        if (command === 'next_events')
          return { runtimeId: 'r', sequence: 0, events: [] };
        throw new Error(command);
      },
    };
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: '添加图片' })).toBeEnabled();
  await expect(page.getByAltText('用户发送的图片')).toBeVisible();
  await page.getByRole('button', { name: '展开图片' }).click();
  await expect(page.getByRole('button', { name: '收起图片' })).toBeVisible();
  const file = {
    name: '截图.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1sAAAAASUVORK5CYII=',
      'base64',
    ),
  };
  await page
    .getByLabel('选择图片文件')
    .setInputFiles([file, { ...file, name: '第二张.png' }]);
  await expect(page.locator('.image-attachment')).toHaveCount(2);
  const firstThumbnail = page.getByRole('button', {
    name: '放大截图.png（1）',
  });
  await firstThumbnail.click();
  await expect(page.getByAltText('预览：截图.png')).toBeVisible();
  await page.screenshot({
    path: 'test-results/attachments-light.png',
    animations: 'disabled',
  });
  await page.getByRole('button', { name: '放大第二张.png（2）' }).click();
  await expect(page.getByAltText('预览：第二张.png')).toBeVisible();
  await page.getByRole('button', { name: '收起预览' }).press('Escape');
  await expect(
    page.getByRole('button', { name: '放大第二张.png（2）' }),
  ).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole('button', { name: '收起侧栏', exact: true })
    .last()
    .click();
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
  });
  await firstThumbnail.click();
  const preview = page.getByRole('region', { name: '待发送图片预览' });
  const bounds = await preview.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: 'test-results/attachments-dark-narrow.png',
    animations: 'disabled',
  });
  await page.getByRole('button', { name: '收起预览' }).click();
  await page.getByRole('textbox', { name: '消息输入' }).press('Enter');
  await expect(page.locator('.image-attachment')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).sent[0].images.length)).toBe(
    2,
  );
  await page.evaluate(() => {
    (window as any).failSend = true;
  });
  await page.getByLabel('选择图片文件').setInputFiles(file);
  await expect(page.locator('.image-attachment')).toHaveCount(1);
  await page.getByRole('textbox', { name: '消息输入' }).fill('分析截图');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '消息输入' })).toHaveValue(
    '分析截图',
  );
  await expect(page.locator('.image-attachment')).toHaveCount(1);
});
