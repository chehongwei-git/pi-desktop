/** 浏览器集成夹具绕过原生 IPC，渲染真实主页面；记录未处理异常与长任务。 */
import { test, expect, type Page } from '@playwright/test';
/** 安装最小 Tauri 端口；模型、文件系统与网络均不会被调用。 */
async function mock(
  page: Page,
  count = 2,
  workspaces = false,
  projectCount = 2,
) {
  await page.addInitScript(
    ({ count, workspaces, projectCount }) => {
      const host = window as any;
      let serial = 0;
      const callbacks = new Map();
      let channel: any;
      let sequence = 0;
      let index = 0;
      let pending: any[] = [];
      let sessionFile = 'mock.jsonl';
      host.ipcCalls = [];
      const settings = {
        schemaVersion: 1,
        piPath: '',
        runtimePath: '',
        extraPath: [],
        sessionDir: '',
        theme: 'light',
        pinnedSessions: [],
        recentProjects: [],
        ...JSON.parse(localStorage.getItem('mock-settings') ?? '{}'),
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
          host.ipcCalls.push({
            command,
            project: args.project,
            action: args.action,
          });
          if (command === 'get_settings') return settings;
          if (command === 'save_settings') {
            Object.assign(settings, args.settings);
            localStorage.setItem('mock-settings', JSON.stringify(settings));
            return;
          }
          if (command === 'read_content') {
            const text = (host.bodies[args.id] as string).slice(
              args.offset,
              args.offset + 65536,
            );
            return {
              text,
              next: args.offset + text.length,
              done: args.offset + text.length >= host.bodies[args.id].length,
            };
          }
          if (command === 'disconnect_pi') return;
          if (command === 'plugin:dialog|open') return 'C:/mock/project';
          if (command === 'list_sessions')
            return host.emptyCatalog
              ? []
              : workspaces
                ? [
                    {
                      path: 'alpha.jsonl',
                      cwd: 'C:/work/alpha',
                      name: '修复登录',
                      preview: '登录问题',
                      modified: 2,
                      timestamp: '',
                      warning: null,
                      id: 'alpha',
                    },
                    {
                      path: 'beta.jsonl',
                      cwd: 'C:/work/beta',
                      name: '添加测试',
                      preview: '测试覆盖率',
                      modified: 1,
                      timestamp: '',
                      warning: null,
                      id: 'beta',
                    },
                    ...Array.from(
                      { length: Math.max(0, projectCount - 2) },
                      (_, i) => ({
                        path: `extra-${i}.jsonl`,
                        cwd: `C:/work/extra-${i}`,
                        name: `额外会话 ${i}`,
                        preview: '',
                        modified: 0,
                        timestamp: '',
                        warning: null,
                        id: `extra-${i}`,
                      }),
                    ),
                  ].map((session) => ({
                    ...session,
                    path: host.windowsPaths
                      ? `C:/sessions/${session.path}`
                      : session.path,
                  }))
                : [];
          if (command === 'connect_pi') {
            if (host.deferConnection)
              await new Promise<void>((resolve) => {
                host.releaseConnection = resolve;
              });
            channel = args.channel;
            return {
              runtimeId: 'mock',
              project: args.project || 'C:/Users/mock',
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
              case 'new_session':
                sessionFile = 'new.jsonl';
                return { cancelled: false };
              case 'switch_session':
                sessionFile = args.action.path;
                return { cancelled: false };
              case 'models':
                return {
                  models: [{ provider: 'mock', id: 'model', name: 'Mock' }],
                };
              case 'thinking_levels':
                return { levels: ['off'] };
              case 'commands':
                return { commands: [] };
              case 'history':
                if (host.slowSession === sessionFile)
                  await new Promise<void>((resolve) => {
                    host.releaseHistory = resolve;
                  });
                return {
                  messages:
                    host.historyMessages ??
                    Array.from({ length: count }, (_, i) =>
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
                  sessionFile: host.windowsPaths
                    ? sessionFile.replace(/\//g, '\\').toUpperCase()
                    : sessionFile,
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
    { count, workspaces, projectCount },
  );
}
test('loaded conversation keeps its name when Windows state paths differ and the catalog refresh is empty', async ({
  page,
}) => {
  await mock(page, 2, true);
  await page.addInitScript(() => {
    (window as any).windowsPaths = true;
  });
  await page.goto('/');
  const recent = page.getByRole('region', { name: '最近', exact: true });
  await recent.locator('.history-item').filter({ hasText: '修复登录' }).click();
  await expect(page.locator('.session-loading')).toHaveCount(0);
  await expect(page.locator('.session-title')).toHaveText('修复登录');
  await page.evaluate(() => {
    (window as any).emptyCatalog = true;
  });
  await recent.locator('.history-item').filter({ hasText: '添加测试' }).click();
  await expect(page.locator('.session-loading')).toHaveCount(0);
  await expect(page.locator('.message')).toHaveCount(2);
  await expect(recent.locator('.history-item')).toHaveCount(0);
  await expect(page.locator('.session-title')).toHaveText('添加测试');
  await page.getByRole('button', { name: /^新对话/ }).click();
  await expect(page.locator('.session-title')).toHaveText('新对话');
});
test('session title updates before slow cross-project loading completes', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await mock(page, 2, true);
  await page.goto('/');
  const recent = page.getByRole('region', { name: '最近', exact: true });
  await recent.locator('.history-item').filter({ hasText: '修复登录' }).click();
  await expect(page.locator('.session-title')).toHaveText('修复登录');
  await expect(page.locator('.message')).toHaveCount(2);
  await page.evaluate(() => {
    (window as any).deferConnection = true;
    (window as any).slowSession = 'beta.jsonl';
  });
  await recent.locator('.history-item').filter({ hasText: '添加测试' }).click();
  await expect(page.locator('.session-title')).toHaveText('添加测试');
  await expect(
    page.getByRole('status', { name: '正在加载会话' }),
  ).toBeVisible();
  await expect(page.locator('.session-loading')).toHaveText('');
  await expect(page.locator('.session-loading svg')).toBeVisible();
  await expect(page.locator('.conversation')).toHaveAttribute(
    'aria-busy',
    'true',
  );
  await expect(page.locator('.message')).toHaveCount(0);
  await expect(
    page.getByRole('textbox', { name: '消息输入', exact: true }),
  ).toBeDisabled();
  await expect
    .poll(() => page.evaluate(() => typeof (window as any).releaseConnection))
    .toBe('function');
  await page.evaluate(() => {
    (window as any).releaseConnection();
  });
  await expect
    .poll(() => page.evaluate(() => typeof (window as any).releaseHistory))
    .toBe('function');
  await expect(page.locator('.session-title')).toHaveText('添加测试');
  await expect(page.locator('.session-loading')).toBeVisible();
  await expect(page.locator('.message')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/session-loading.png' });
  await page.evaluate(() => {
    (window as any).releaseHistory();
  });
  await expect(page.locator('.session-loading')).toHaveCount(0);
  await expect(page.locator('.session-title')).toHaveText('添加测试');
  await expect(page.locator('.message')).toHaveCount(2);
  await expect(page.locator('.conversation')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  await expect(
    page.getByRole('textbox', { name: '消息输入', exact: true }),
  ).toBeEnabled();
  expect(errors).toEqual([]);
});
test('new conversation without a project starts in the user directory', async ({
  page,
}) => {
  await mock(page, 0);
  await page.goto('/');
  await page.getByRole('button', { name: /^新对话/ }).click();
  await expect(page.getByText('已连接', { exact: true })).toBeVisible();
  await expect(page.locator('.welcome p')).toHaveText('C:/Users/mock');
  await expect(
    page.getByRole('textbox', { name: '消息输入', exact: true }),
  ).toBeEnabled();
  await page.getByRole('button', { name: /^新对话/ }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).ipcCalls.filter(
            (c: any) => c.action?.type === 'new_session',
          ).length,
      ),
    )
    .toBe(1);
  const calls = await page.evaluate(() => (window as any).ipcCalls);
  expect(
    calls
      .filter((c: any) => c.command === 'connect_pi')
      .map((c: any) => c.project),
  ).toEqual(['']);
  expect(
    calls.filter((c: any) => c.command === 'plugin:dialog|open'),
  ).toHaveLength(0);
});
test('sidebar sections limit projects and persist pinned conversations', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await mock(page, 2, true, 8);
  await page.goto('/');
  const projects = page.getByRole('region', { name: '工作项目', exact: true });
  const recent = page.getByRole('region', { name: '最近', exact: true });
  const pinned = page.getByRole('region', { name: '置顶', exact: true });
  await expect(projects.locator('.project-current')).toHaveCount(5);
  await projects.getByRole('button', { name: '显示全部 8 个项目' }).click();
  await expect(projects.locator('.project-current')).toHaveCount(8);
  await projects.locator('.section-toggle').click();
  await expect(projects.locator('.project-current')).toHaveCount(0);
  await projects.locator('.section-toggle').click();
  await expect(projects.locator('.project-current')).toHaveCount(5);
  await expect(recent.locator('.history-item')).toHaveCount(8);
  await expect(recent.locator('.history-item').first()).toContainText(
    '修复登录',
  );
  await recent.locator('.section-toggle').click();
  await expect(recent.locator('.history-item')).toHaveCount(0);
  await recent.locator('.section-toggle').click();
  await recent
    .getByRole('button', { name: '置顶 修复登录', exact: true })
    .click();
  await expect(pinned.locator('.history-item')).toHaveCount(1);
  await expect(pinned.locator('.history-item')).toContainText('修复登录');
  await pinned.locator('.section-toggle').click();
  await expect(pinned.locator('.history-item')).toHaveCount(0);
  await pinned.locator('.section-toggle').click();
  await page.reload();
  await expect(pinned.locator('.history-item')).toContainText('修复登录');
  await pinned.locator('.history-item').click();
  await expect(pinned.locator('.history-item')).toHaveAttribute(
    'aria-current',
    'page',
  );
  await pinned
    .getByRole('button', { name: '取消置顶 修复登录', exact: true })
    .click();
  await expect(pinned.locator('.history-item')).toHaveCount(0);
  await page.reload();
  await expect(pinned.locator('.history-item')).toHaveCount(0);
  await page.getByRole('textbox', { name: '搜索历史会话' }).fill('额外会话 5');
  await expect(projects.locator('.project-current')).toHaveCount(1);
  await expect(projects.locator('.history-item')).toHaveText('额外会话 5');
  await page.screenshot({ path: 'test-results/sidebar-sections.png' });
  expect(errors).toEqual([]);
});
test('workspace tree discovers, expands, searches and restores across projects', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await mock(page, 2, true);
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  const projectTree = page.getByRole('region', {
    name: '工作项目',
    exact: true,
  });
  const alpha = page.getByRole('button', { name: 'alpha 1', exact: true });
  const beta = page.getByRole('button', { name: 'beta 1', exact: true });
  await expect(alpha).toHaveAttribute('aria-expanded', 'false');
  await expect(beta).toBeVisible();
  const originalOrder = await projectTree
    .locator('.project-name')
    .allTextContents();
  await expect(
    projectTree.getByRole('button', { name: '修复登录', exact: true }),
  ).toHaveCount(0);
  await alpha.click();
  await beta.click();
  await expect(
    projectTree.getByRole('button', { name: '修复登录', exact: true }),
  ).toBeVisible();
  await expect(
    projectTree.getByRole('button', { name: '添加测试', exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() =>
      (window as any).ipcCalls.filter((c: any) => c.command === 'connect_pi'),
    ),
  ).toHaveLength(0);
  await page.screenshot({ path: 'test-results/workspaces-light.png' });
  await page.getByRole('textbox', { name: '搜索历史会话' }).fill('覆盖率');
  await expect(alpha).toHaveCount(0);
  await expect(
    projectTree.getByRole('button', { name: '添加测试', exact: true }),
  ).toBeVisible();
  await page.getByRole('textbox', { name: '搜索历史会话' }).fill('');
  await projectTree
    .getByRole('button', { name: '修复登录', exact: true })
    .click();
  await expect(
    projectTree.getByRole('button', { name: '修复登录', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
  await projectTree
    .getByRole('button', { name: '添加测试', exact: true })
    .click();
  await expect(
    projectTree.getByRole('button', { name: '添加测试', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
  const calls = await page.evaluate(() =>
    (window as any).ipcCalls
      .filter((c: any) => c.command === 'connect_pi')
      .map((c: any) => c.project),
  );
  expect(calls).toEqual(['C:/work/alpha', 'C:/work/beta']);
  expect(await projectTree.locator('.project-name').allTextContents()).toEqual(
    originalOrder,
  );
  await page.keyboard.press('Control+,');
  await page
    .getByRole('combobox', { name: '外观', exact: true })
    .selectOption('system');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.screenshot({ path: 'test-results/workspaces-dark.png' });
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await beta.focus();
  await expect(beta).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(beta).toHaveAttribute('aria-expanded', 'false');
  expect(errors).toEqual([]);
});
test('new conversation project picker searches all projects and supports new directories and home', async ({
  page,
}) => {
  await mock(page, 0, true, 8);
  await page.goto('/');
  await page.getByRole('button', { name: /^新对话/ }).click();
  const picker = page.getByRole('button', {
    name: '选择新对话项目',
    exact: true,
  });
  await expect(picker).toBeEnabled();
  const callsBefore = await page.evaluate(
    () =>
      (window as any).ipcCalls.filter((c: any) => c.command === 'connect_pi')
        .length,
  );
  await picker.click();
  const panel = page.getByRole('region', { name: '新对话项目', exact: true });
  await expect(
    panel.getByRole('button', { name: /C:\/work\/extra-5/ }),
  ).toBeVisible();
  await page
    .getByRole('textbox', { name: '搜索项目', exact: true })
    .fill('BETA');
  await expect(
    panel.getByRole('button', { name: /C:\/work\/beta/ }),
  ).toBeVisible();
  await expect(
    panel.getByRole('button', { name: /C:\/work\/alpha/ }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        (window as any).ipcCalls.filter((c: any) => c.command === 'connect_pi')
          .length,
    ),
  ).toBe(callsBefore);
  await page
    .getByRole('textbox', { name: '消息输入', exact: true })
    .fill('保留项目选择前的草稿');
  await picker.click();
  await panel.getByRole('button', { name: /C:\/work\/beta/ }).click();
  await expect(picker).toHaveText('beta');
  await expect(
    page.getByRole('textbox', { name: '消息输入', exact: true }),
  ).toHaveValue('保留项目选择前的草稿');
  await picker.click();
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(picker).toBeFocused();
  await picker.click();
  await panel.getByRole('button', { name: /新建项目/ }).click();
  await expect(picker).toHaveText('project');
  await picker.click();
  await panel.getByRole('button', { name: /不在此项目工作/ }).click();
  await expect(picker).toHaveText('不在此项目工作');
  const calls = await page.evaluate(() => (window as any).ipcCalls);
  expect(
    calls
      .filter((c: any) => c.command === 'connect_pi')
      .map((c: any) => c.project),
  ).toEqual(['', 'C:/work/beta', 'C:/mock/project', '']);
  await picker.click();
  await page.screenshot({ path: 'test-results/project-picker-light.png' });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
  });
  await page.screenshot({ path: 'test-results/project-picker-dark.png' });
});

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
test('full-content actions only appear for truncated messages and still open the remaining text', async ({
  page,
}) => {
  await mock(page);
  await page.addInitScript(() => {
    const message = (id: string, role: string, truncated: boolean) => ({
      id,
      role,
      text: `正文 ${id}`,
      thinking: '',
      status: 'done',
      contentRef: id,
      name: '工具',
      truncated,
    });
    (window as any).historyMessages = [
      message('short-answer', 'assistant', false),
      message('short-tool', 'toolResult', false),
      message('long-tool', 'toolResult', true),
      message('long-answer', 'assistant', true),
    ];
    (window as any).bodies = { 'long-answer': 'a'.repeat(65536) + '剩余正文' };
  });
  await page.goto('/');
  await page
    .getByRole('button', { name: '选择项目文件夹', exact: true })
    .last()
    .click();
  const messages = page.locator('.message');
  await expect(messages).toHaveCount(4);
  await expect(
    messages
      .filter({ hasText: '正文 short-answer' })
      .getByRole('button', { name: '查看完整正文' }),
  ).toHaveCount(0);
  const shortTool = messages.filter({ hasText: '正文 short-tool' });
  await shortTool.locator('summary').click();
  await expect(
    shortTool.getByRole('button', { name: '分块查看完整输出' }),
  ).toHaveCount(0);
  const longTool = messages.filter({ hasText: '正文 long-tool' });
  await longTool.locator('summary').click();
  await expect(
    longTool.getByRole('button', { name: '分块查看完整输出' }),
  ).toBeVisible();
  await page.getByRole('button', { name: '查看完整正文', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '下一块', exact: true }).click();
  await expect(dialog.locator('.full-content')).toHaveText('剩余正文');
  await expect(
    dialog.getByRole('button', { name: '已到末尾', exact: true }),
  ).toBeDisabled();
});
test('the first small upward wheel gesture leaves the bottom without snapping back', async ({
  page,
}) => {
  await mock(page, 300);
  await page.goto('/');
  await page
    .getByRole('button', { name: '选择项目文件夹', exact: true })
    .last()
    .click();
  const transcript = page.getByRole('region', {
    name: '对话消息',
    exact: true,
  });
  const distanceFromBottom = () =>
    transcript.evaluate(
      (node) => node.scrollHeight - node.clientHeight - node.scrollTop,
    );
  await expect.poll(distanceFromBottom).toBeLessThan(3);
  await transcript.hover();
  await page.mouse.wheel(0, -24);
  // 等待滚动、动态测量及跟随帧结束，确认第一次手势没有被拉回底部。
  await page.waitForTimeout(400);
  expect(await distanceFromBottom()).toBeGreaterThan(10);
  await expect(
    page.getByRole('button', { name: '回到底部', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '回到底部', exact: true }).click();
  await expect.poll(distanceFromBottom).toBeLessThan(3);
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
