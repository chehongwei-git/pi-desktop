/** 浏览器使用真实输入框，IPC 夹具只返回历史和确认发送。 */
import { test, expect } from '@playwright/test';

test('连续翻阅提示词，修改后发送', async ({ page }) => {
  await page.addInitScript(() => {
    const host = window as any;
    let serial = 0;
    const messages = ['第一条要求', '第二条要求', '第三条要求'].map(
      (text, i) => ({
        id: String(i),
        role: 'user',
        text,
        thinking: '',
        contentRef: null,
        status: 'done',
        name: null,
      }),
    );
    host.sent = [];
    host.__TAURI_INTERNALS__ = {
      transformCallback: () => ++serial,
      unregisterCallback: () => {},
      async invoke(command: string, args: any = {}) {
        if (command === 'get_settings')
          return {
            schemaVersion: 1,
            piPath: '',
            runtimePath: '',
            extraPath: [],
            sessionDir: '',
            recentProjects: [],
            projectOrder: [],
            pinnedSessions: [],
            theme: 'light',
            zoom: 100,
          };
        if (command === 'list_sessions') return [];
        if (command === 'connect_pi')
          return {
            runtimeId: 'mock',
            project: 'project',
            version: '1.4.0',
            verified: true,
            snapshot: { sessionFile: 'session' },
          };
        if (command === 'perform') {
          if (args.action.type === 'history')
            return { messages, before: 0, hasMore: false };
          if (args.action.type === 'models') return { models: [] };
          if (args.action.type === 'commands') return { commands: [] };
          if (args.action.type === 'thinking_levels')
            return { levels: ['off'] };
          if (args.action.type === 'prompt') {
            host.sent.push(args.action.message);
            return {};
          }
          return {};
        }
        return {};
      },
    };
  });
  await page.goto('/');
  const input = page.getByRole('textbox', { name: '消息输入' });
  await expect(input).toBeEnabled();
  await input.press('ArrowUp');
  await expect(input).toHaveValue('第三条要求');
  await input.press('ArrowUp');
  await expect(input).toHaveValue('第二条要求');
  await input.press('ArrowUp');
  await expect(input).toHaveValue('第一条要求');
  await input.press('ArrowDown');
  await expect(input).toHaveValue('第二条要求');
  await input.fill('第二条要求，补充测试');
  await input.press('ArrowUp');
  await expect(input).toHaveValue('第二条要求，补充测试');
  await input.press('Enter');
  await expect(input).toHaveValue('');
  expect(await page.evaluate(() => (window as any).sent)).toEqual([
    '第二条要求，补充测试',
  ]);
});
