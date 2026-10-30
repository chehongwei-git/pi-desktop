/** 浏览器集成夹具绕过原生 IPC，渲染真实主页面；记录未处理异常与长任务。 */
import { test, expect, type Page } from '@playwright/test';
/** 安装最小 Tauri 端口；模型、文件系统与网络均不会被调用。 */
async function mock(page: Page, count = 2) {
  await page.addInitScript(
    ({ count }) => {
      const host = window as any;
      let serial = 0;
      const callbacks = new Map();
      let channel: any;
      let sequence = 0;
      let index = 0;
      let pending: any[] = [];
      const settings = {
        schemaVersion: 1,
        piPath: '',
        runtimePath: '',
        extraPath: [],
        sessionDir: '',
        theme: 'light',
        recentProjects: [],
      };
      const message = (id: string, role: string, text: string) => ({
        id,
        role,
        text,
        thinking: '',
        status: 'done',
        contentRef: null,
        name: null,
      });
      host.__TAURI_INTERNALS__ = {
        transformCallback(callback: any) {
          const id = ++serial;
          callbacks.set(id, callback);
          return id;
        },
        unregisterCallback(id: number) {
          callbacks.delete(id);
        },
        async invoke(command: string, args: any = {}) {
          if (command === 'get_settings') return settings;
          if (command === 'save_settings' || command === 'disconnect_pi')
            return;
          if (command === 'plugin:dialog|open') return 'C:/mock/project';
          if (command === 'list_sessions') return [];
          if (command === 'connect_pi') {
            channel = args.channel;
            return {
              runtimeId: 'mock',
              project: args.project,
              version: '1.4.0',
              verified: true,
              snapshot: {
                sessionFile: 'mock.jsonl',
                model: { provider: 'mock', id: 'model' },
                thinkingLevel: 'off',
                isStreaming: false,
              },
            };
          }
          if (command === 'next_events') {
            const events = pending;
            pending = [];
            if (events.length) sequence++;
            return { runtimeId: 'mock', sequence, events };
          }
          if (command === 'perform') {
            switch (args.action.type) {
              case 'models':
                return {
                  models: [{ provider: 'mock', id: 'model', name: 'Mock' }],
                };
              case 'thinking_levels':
                return { levels: ['off'] };
              case 'commands':
                return { commands: [] };
              case 'history':
                return {
                  messages: Array.from({ length: count }, (_, i) =>
                    message(
                      String(i),
                      i % 2 ? 'assistant' : 'user',
                      `消息 ${i}：这是模拟正文，用于验证动态列表。\n\n**Markdown** 与中文排版。`,
                    ),
                  ),
                  before: 0,
                  hasMore: false,
                };
              case 'prompt':
                pending = [
                  { type: 'run', state: 'running' },
                  {
                    type: 'message',
                    message: message('new-user', 'user', args.action.message),
                  },
                  {
                    type: 'message',
                    message: message(
                      'new-assistant',
                      'assistant',
                      '这是模拟回答。',
                    ),
                  },
                  { type: 'run', state: 'idle' },
                ];
                setTimeout(
                  () =>
                    callbacks.get(channel.id)({
                      index: index++,
                      message: { type: 'available', runtimeId: 'mock' },
                    }),
                  10,
                );
                return {};
              case 'state':
                return {
                  sessionFile: 'mock.jsonl',
                  model: { provider: 'mock', id: 'model' },
                  thinkingLevel: 'off',
                  isStreaming: false,
                };
            }
          }
          throw new Error(`unmocked IPC: ${command}`);
        },
      };
      host.longTasks = [];
      new PerformanceObserver((list) => {
        host.longTasks.push(...list.getEntries().map((e) => e.duration));
      }).observe({ entryTypes: ['longtask'] });
    },
    { count },
  );
}
test('welcome, project, conversation, send and shortcuts', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await mock(page);
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: '让 Pi 与你的项目一起工作' }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: '选择项目文件夹', exact: true })
    .last()
    .click();
  await expect(page.getByText('已连接', { exact: true })).toBeVisible();
  await expect(page.locator('.message')).toHaveCount(2);
  await page
    .getByRole('textbox', { name: '消息输入', exact: true })
    .fill('测试发送');
  await page
    .getByRole('textbox', { name: '消息输入', exact: true })
    .press('Enter');
  await expect(page.getByText('这是模拟回答。', { exact: true })).toBeVisible();
  await page.keyboard.press('Control+,');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/conversation.png' });
  expect(errors).toEqual([]);
});
test('10000 messages mount a bounded visible window', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await mock(page, 10000);
  await page.goto('/');
  await page
    .getByRole('button', { name: '选择项目文件夹', exact: true })
    .last()
    .click();
  await expect(page.getByText('已连接', { exact: true })).toBeVisible();
  await expect(page.locator('.message').first()).toBeVisible();
  expect(await page.locator('.message').count()).toBeLessThan(40);
  await page.locator('.transcript').evaluate((element) => {
    element.scrollTop = element.scrollHeight / 2;
  });
  await page.mouse.move(700, 350);
  await page.mouse.wheel(0, -800);
  await expect(page.getByRole('button', { name: '回到底部' })).toBeVisible();
  expect(errors).toEqual([]);
  const durations = await page.evaluate(() => (window as any).longTasks);
  console.log('browser long tasks (ms)', durations);
});
