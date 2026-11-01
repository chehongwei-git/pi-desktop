import { test, expect } from '@playwright/test';

test('returns from a new-chat draft to existing sessions', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    let sessionFile = 'original.jsonl';
    let extensionEvents = [
      {
        type: 'extension',
        request: {
          method: 'setWidget',
          widgetKey: 'plan-todos',
          widgetLines: [
            '☑ 检查项目',
            '☐ 原会话待办：完成方案',
            '☐ 验证最终实现',
          ],
        },
      },
      {
        type: 'extension',
        request: {
          method: 'setStatus',
          statusKey: 'plan-mode',
          statusText: '⏸ plan',
        },
      },
    ];
    const cwd = '/workspace/project';
    const sessions = ['original', 'other'].map((id) => ({
      id,
      path: `${id}.jsonl`,
      cwd,
      name: id,
      preview: '',
      timestamp: '',
      modified: 0,
      warning: null,
    }));
    const snapshot = () => ({ sessionFile, cwd, isStreaming: false });
    (window as any).__TAURI_INTERNALS__ = {
      transformCallback: (callback: (event: unknown) => void) => {
        // 模拟宿主扩展事件唤醒，连接完成后才触发拉取。
        (window as any).wakeExtensions = () =>
          callback({
            index: 0,
            message: { type: 'available', runtimeId: 'runtime' },
          });
        return 1;
      },
      unregisterCallback: () => {},
      async invoke(command: string, args: any = {}) {
        if (command === 'get_settings')
          return { recentProjects: [], extraPath: [] };
        if (command === 'save_settings') return;
        if (command === 'list_sessions') return sessions;
        if (command === 'connect_pi')
          return {
            runtimeId: 'runtime',
            project: cwd,
            snapshot: snapshot(),
            version: '1.4.0',
            verified: true,
          };
        if (command === 'next_events') {
          const events = extensionEvents;
          extensionEvents = [];
          return { runtimeId: 'runtime', sequence: 1, events };
        }
        if (command === 'perform') {
          switch (args.action.type) {
            case 'new_session':
              sessionFile = 'new.jsonl';
              return { cancelled: false };
            case 'prompt':
              return {};
            case 'switch_session':
              // A switch hook may cancel a redundant restore of the active session.
              if (sessionFile === args.action.path) return { cancelled: true };
              sessionFile = args.action.path;
              return { cancelled: false };
            case 'state':
              return snapshot();
            case 'history':
              return {
                messages: [
                  {
                    id: sessionFile,
                    role: 'user',
                    text: `History: ${sessionFile}`,
                    thinking: '',
                    status: 'done',
                    contentRef: null,
                    name: null,
                  },
                ],
                before: 0,
                hasMore: false,
              };
            case 'models':
              return { models: [] };
            case 'thinking_levels':
              return { levels: [] };
            case 'commands':
              return { commands: [] };
          }
        }
        throw new Error(`Unexpected command: ${command}`);
      },
    };
  });
  await page.goto('/');
  const input = page.getByRole('textbox', { name: '消息输入', exact: true });
  const recent = page.getByRole('region', { name: '最近', exact: true });
  await expect(page.getByText('已连接', { exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).wakeExtensions());
  const todo = page.getByRole('region', { name: '执行计划', exact: true });
  const status = page.locator('.extension-status');
  await expect(todo).toBeVisible();
  await expect(status).toHaveText('⏸ plan');
  await expect(todo.getByRole('progressbar')).toHaveAttribute('value', '1');
  await todo.getByRole('button', { name: '展开全部' }).click();
  await expect(todo.getByRole('listitem')).toHaveCount(3);
  await expect(todo).toContainText('原会话待办：完成方案');
  await input.fill('Existing draft');
  await page.getByRole('button', { name: /^新对话/ }).click();
  await expect(page.locator('.welcome')).toBeVisible();
  await expect(input).toHaveValue('');
  await expect(todo).toHaveCount(0);
  await expect(status).toHaveCount(0);
  await input.fill('New draft');
  await recent
    .getByRole('button', { name: 'original project', exact: true })
    .click();
  await expect(page.locator('.welcome')).toHaveCount(0);
  await expect(page.locator('.session-title')).toHaveText('original');
  await expect(input).toHaveValue('Existing draft');
  // 返回原会话不能因为准备新草稿而丢失扩展待办。
  await expect(todo).toBeVisible();
  await expect(todo).toContainText('原会话待办：完成方案');
  await expect(status).toHaveText('⏸ plan');
  await page.screenshot({
    path: 'test-results/plan-card-light.png',
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole('button', { name: '收起侧栏', exact: true })
    .last()
    .click();
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
  });
  const cardBounds = await todo.boundingBox();
  expect(cardBounds!.x).toBeGreaterThanOrEqual(0);
  expect(cardBounds!.x + cardBounds!.width).toBeLessThanOrEqual(390);
  await todo.getByRole('button', { name: '展开全部' }).press('Enter');
  const steps = todo.getByRole('group', { name: '计划步骤' });
  await expect(steps).toBeVisible();
  await steps.focus();
  await steps.press('Escape');
  await expect(todo.getByRole('button', { name: '展开全部' })).toBeFocused();
  await page.screenshot({
    path: 'test-results/plan-card-dark-narrow.png',
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.getByRole('button', { name: '展开侧栏', exact: true }).click();
  await page.getByRole('button', { name: /^新对话/ }).click();
  await expect(input).toHaveValue('New draft');
  await expect(todo).toHaveCount(0);
  await expect(status).toHaveCount(0);
  await recent
    .getByRole('button', { name: 'other project', exact: true })
    .click();
  await expect(page.locator('.session-title')).toHaveText('other');
  await expect(
    page.getByText('History: other.jsonl', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '会话菜单', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '复制会话路径', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: '断开 Pi', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: '会话菜单', exact: true }).click();
  await page.getByRole('button', { name: /^新对话/ }).click();
  await expect(input).toHaveValue('New draft');
  await input.press('Enter');
  await expect(input).toHaveValue('');
  await expect(page.locator('.session-loading')).toHaveCount(0);
  await page.getByRole('button', { name: /^新对话/ }).click();
  await expect(page.locator('.welcome')).toBeVisible();
  await expect(input).toHaveValue('');
  await recent
    .getByRole('button', { name: 'original project', exact: true })
    .click();
  await expect(input).toHaveValue('Existing draft');
  expect(errors).toEqual([]);
});
