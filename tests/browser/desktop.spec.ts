/** 浏览器集成夹具绕过原生 IPC，渲染真实主页面；记录未处理异常与长任务。 */
import { test, expect, type Page } from '@playwright/test';

// 主题切换后截图不应混入过渡中的旧颜色，同时覆盖减少动画偏好。
test.use({ reducedMotion: 'reduce' });
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
      let cwd = 'C:/Users/mock';
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
            if (host.failSaveOnce) {
              host.failSaveOnce = false;
              throw new Error('模拟保存失败');
            }
            Object.assign(settings, args.settings);
            localStorage.setItem('mock-settings', JSON.stringify(settings));
            return;
          }
          if (command === 'read_content') {
            if (host.failContentOnce === args.id) {
              host.failContentOnce = '';
              throw new Error('模拟正文读取失败');
            }
            if (host.deferContent === args.id)
              await new Promise<void>((resolve) => {
                host.releaseContent = resolve;
              });
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
          if (command === 'list_sessions' && host.sessionCatalog)
            return host.sessionCatalog;
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
            cwd = args.project || 'C:/Users/mock';
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
              case 'extension_response':
                if (
                  args.action.id === 'plan-stop' &&
                  args.action.value.cancelled
                )
                  host.finishPlanStop?.({});
                return {};
              case 'stop':
                if (host.planStop) {
                  return new Promise((resolve) => {
                    host.finishPlanStop = resolve;
                    host.emitEvents([
                      {
                        type: 'extension',
                        request: {
                          type: 'extension_ui_request',
                          id: 'plan-stop',
                          method: 'select',
                          title: 'Plan mode - what next?',
                          options: ['Execute the plan', 'Stay in plan mode'],
                        },
                      },
                    ]);
                  });
                }
                return {};
              case 'new_project_session':
                cwd = args.action.project || 'C:/Users/mock';
                sessionFile = 'new-project.jsonl';
                return { cancelled: false };
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
              case 'set_model':
              case 'set_thinking':
              case 'set_auto_compaction':
              case 'set_steering_mode':
              case 'set_follow_up_mode':
                return {};
              case 'thinking_levels':
                return { levels: ['off'] };
              case 'commands':
                return { commands: host.bridgeCommands ?? [] };
              case 'session_tree':
                if (host.fatalTree) {
                  callbacks.get(channel.id)({
                    index: index++,
                    message: {
                      type: 'failed',
                      runtimeId: 'mock',
                      error: {
                        code: 'PROTOCOL',
                        message: 'Pi stdout 不是有效 JSONL',
                        diagnosticId: 'test-tree',
                      },
                    },
                  });
                  throw new Error('Pi stdout 不是有效 JSONL');
                }
                if (host.deferTree)
                  await new Promise<void>((resolve) => {
                    host.releaseTree = resolve;
                  });
                if (host.treeError) throw new Error('模拟树加载失败');
                return { nodes: [] };
              case 'history':
                if (host.slowSession === sessionFile)
                  await new Promise<void>((resolve) => {
                    host.releaseHistory = resolve;
                  });
                if (!host.historyMessages) {
                  const end = args.action.before ?? count;
                  const start = Math.max(0, end - 50);
                  return {
                    messages: Array.from({ length: end - start }, (_, i) =>
                      message(
                        String(start + i),
                        (start + i) % 2 ? 'assistant' : 'user',
                        `消息 ${start + i}：这是模拟正文。`,
                      ),
                    ),
                    before: start,
                    hasMore: start > 0,
                  };
                }
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
                if (host.queuePrompts && args.action.mode)
                  return { disposition: 'queued' };
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
                  ...(!host.holdRun ? [{ type: 'run', state: 'idle' }] : []),
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
              case 'session_stats':
                // 用量叠在真实统计形状上，浏览器验收同时覆盖折叠读数与展开明细。
                if (host.statsError) throw new Error('模拟统计失败');
                return {
                  sessionFile,
                  sessionId: 'mock',
                  userMessages: 1,
                  assistantMessages: 1,
                  toolCalls: 0,
                  toolResults: 0,
                  totalMessages: 2,
                  tokens: {
                    input: 50000,
                    output: 10000,
                    cacheRead: 40000,
                    cacheWrite: 5000,
                    total: 105000,
                  },
                  cost: 0.45,
                  contextUsage:
                    host.statsUnknown || host.statsHidden
                      ? host.statsHidden
                        ? undefined
                        : {
                            tokens: null,
                            contextWindow: 200000,
                            percent: null,
                          }
                      : {
                          tokens: 118000,
                          contextWindow: 200000,
                          percent: 59,
                        },
                };
              case 'state':
                return {
                  cwd,
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
      host.emitEvents = (events: unknown[]) => {
        pending.push(...events);
        callbacks.get(channel.id)({
          index: index++,
          message: { type: 'available', runtimeId: 'mock' },
        });
      };
      host.longTasks = [];
      new PerformanceObserver((list) => {
        host.longTasks.push(...list.getEntries().map((e) => e.duration));
      }).observe({ entryTypes: ['longtask'] });
    },
    { count, workspaces, projectCount },
  );
}
test('slash commands list executable commands, complete with keyboard and execute locally in both themes', async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem('mock-settings', JSON.stringify({ theme: 'system' }));
  });
  await mock(page);
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  const input = page.getByRole('textbox', { name: '消息输入' });
  await expect(input).toBeEnabled();
  await input.fill('/');
  const menu = page.getByRole('listbox', { name: 'Pi 命令' });
  await expect(menu.getByRole('option')).toHaveCount(13);
  await expect(menu.getByRole('option', { name: /\/hotkeys/ })).toHaveCount(0);
  await expect(menu.getByRole('option', { name: /\/login/ })).toHaveCount(0);
  await input.press('ArrowUp');
  await expect(menu.getByRole('option', { name: /\/export/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.screenshot({ path: 'test-results/slash-commands-light.png' });
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.screenshot({ path: 'test-results/slash-commands-dark.png' });
  await input.fill('/model');
  await input.press('Tab');
  await expect(input).toHaveValue('/model ');
  await expect(menu).toHaveCount(0);
  await input.press('Enter');
  const models = page.getByRole('listbox', { name: '/model · 选择模型' });
  await expect(models).toBeVisible();
  await models.getByRole('option', { name: /mock\/model/ }).click();
  await expect(models).toHaveCount(0);
  const dialog = page.getByRole('dialog');
  await input.fill('/login anthropic');
  await input.press('Enter');
  await expect(dialog.getByText(/\/login anthropic/)).toBeVisible();
  const actions = await page.evaluate(() =>
    (window as any).ipcCalls
      .filter((call: any) => call.command === 'perform')
      .map((call: any) => call.action),
  );
  expect(actions.some((action: any) => action.type === 'set_model')).toBe(true);
  expect(actions.some((action: any) => action.type === 'prompt')).toBe(false);
});

test('tree Esc restores input during pending loading and after an error', async ({
  page,
}) => {
  await mock(page);
  await page.addInitScript(() => {
    const host = window as any;
    host.bridgeCommands = [
      { name: 'pi-desktop-navigate-v1', source: 'extension' },
    ];
    host.deferTree = true;
  });
  await page.goto('/');
  let input = page.getByRole('textbox', { name: '消息输入' });
  await expect(input).toBeEnabled();
  await input.fill('/tree');
  await input.press('Enter');
  await expect(page.getByRole('textbox', { name: '搜索菜单' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(input).toBeFocused();
  await input.fill('/thinking');
  await page.evaluate(() => {
    const host = window as any;
    host.deferTree = false;
    host.releaseTree();
    host.treeError = true;
  });
  await input.fill('/tree');
  await input.press('Enter');
  await expect(page.getByRole('alert')).toHaveText('模拟树加载失败');
  const back = page.getByRole('button', { name: '← 返回' });
  await back.focus();
  await page.keyboard.press('Escape');
  await expect(input).toBeFocused();
  await input.fill('继续工作');
  await input.press('Enter');
  await expect(page.getByText('这是模拟回答。', { exact: true })).toBeVisible();
});

test('fatal tree protocol failure still allows draft editing after clicking return', async ({
  page,
}) => {
  await mock(page);
  await page.addInitScript(() => {
    const host = window as any;
    host.bridgeCommands = [
      { name: 'pi-desktop-navigate-v1', source: 'extension' },
    ];
    host.fatalTree = true;
  });
  await page.goto('/');
  const input = page.getByRole('textbox', { name: '消息输入' });
  await expect(input).toBeEnabled();
  await input.fill('/tree');
  await input.press('Enter');
  await expect(page.getByRole('listbox')).toContainText('不是有效 JSONL');
  await page.getByRole('button', { name: '← 返回' }).click();
  await expect(input).toBeEnabled();
  await expect(input).toBeFocused();
  await input.fill('连接失败后仍能编辑');
  await expect(input).toHaveValue('连接失败后仍能编辑');
  await expect(
    page.getByRole('button', { name: '发送消息', exact: true }),
  ).toBeDisabled();
});

test('closing an inline plan choice sends cancellation with its original ID', async ({
  page,
}) => {
  await mock(page);
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: '消息输入' })).toBeEnabled();
  await page.evaluate(() =>
    (window as any).emitEvents([
      {
        type: 'extension',
        request: {
          type: 'extension_ui_request',
          id: 'original-plan-choice',
          method: 'select',
          title: 'Plan mode - what next?',
          options: ['Execute the plan', 'Stay in plan mode'],
        },
      },
    ]),
  );
  const choice = page.getByRole('region', { name: 'Plan mode - what next?' });
  await expect(choice).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: '消息输入' })).toBeEnabled();
  await choice.getByRole('button', { name: '取消', exact: true }).click();
  await expect(choice).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).ipcCalls.filter(
            (call: any) =>
              call.action?.type === 'extension_response' &&
              call.action.id === 'original-plan-choice' &&
              call.action.value.cancelled,
          ).length,
      ),
    )
    .toBe(1);
});

test('inline plan execution preserves the original selection value', async ({
  page,
}) => {
  await mock(page);
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: '消息输入' })).toBeEnabled();
  await page.evaluate(() =>
    (window as any).emitEvents([
      {
        type: 'extension',
        request: {
          type: 'extension_ui_request',
          id: 'plan-execute',
          method: 'select',
          title: 'Plan mode - what next?',
          options: [
            'Execute the plan (track progress)',
            'Stay in plan mode',
            'Refine the plan',
          ],
        },
      },
    ]),
  );
  const choice = page.getByRole('region', { name: 'Plan mode - what next?' });
  await expect(choice).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await choice
    .getByRole('button', {
      name: 'Execute the plan (track progress)',
      exact: true,
    })
    .click();
  await expect(choice).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).ipcCalls.some(
          (call: any) =>
            call.action?.type === 'extension_response' &&
            call.action.id === 'plan-execute' &&
            call.action.value.value === 'Execute the plan (track progress)',
        ),
      ),
    )
    .toBe(true);
});

for (const method of ['input', 'editor', 'confirm', 'select']) {
  test(`extension ${method} questions stay inline and preserve the chat draft`, async ({
    page,
  }) => {
    await mock(page);
    await page.goto('/');
    const draft = page.getByRole('textbox', { name: '消息输入' });
    await expect(draft).toBeEnabled();
    await draft.fill('保留消息草稿');
    await page.evaluate(
      (method) =>
        (window as any).emitEvents([
          {
            type: 'extension',
            request: {
              type: 'extension_ui_request',
              id: `question-${method}`,
              method,
              title: '补充方案细节',
              message: '请提供你的偏好',
              prefill: '初始内容',
              options: ['选项一', '选项二'],
            },
          },
        ]),
      method,
    );
    const question = page.getByRole('region', { name: '补充方案细节' });
    await expect(question).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(draft).toHaveValue('保留消息草稿');
    if (method === 'input' || method === 'editor') {
      const answer = question.getByRole('textbox', { name: '输入内容' });
      await expect(answer).toHaveValue('初始内容');
      await answer.fill('补充回答');
      await question.getByRole('button', { name: '提交', exact: true }).click();
    } else if (method === 'confirm') {
      await question.getByRole('button', { name: '确认', exact: true }).click();
    } else {
      await question
        .getByRole('button', { name: '选项二', exact: true })
        .click();
    }
    await expect(question).toHaveCount(0);
    await expect(draft).toHaveValue('保留消息草稿');
    await expect
      .poll(() =>
        page.evaluate(
          ({ method }) =>
            (window as any).ipcCalls.some(
              (call: any) =>
                call.action?.type === 'extension_response' &&
                call.action.id === `question-${method}` &&
                (method === 'confirm'
                  ? call.action.value.confirmed === true
                  : call.action.value.value ===
                    (method === 'select' ? '选项二' : '补充回答')),
            ),
          { method },
        ),
      )
      .toBe(true);
  });
}

test('plan status is readable and stop cancels the extension choice without hanging', async ({
  page,
}) => {
  await mock(page);
  await page.goto('/');
  const input = page.getByRole('textbox', { name: '消息输入' });
  await expect(input).toBeEnabled();
  await page.evaluate(() => {
    const host = window as any;
    host.planStop = true;
    host.holdRun = true;
    host.emitEvents([
      {
        type: 'extension',
        request: {
          type: 'extension_ui_request',
          method: 'setStatus',
          statusKey: 'plan-mode',
          statusText: '\x1b[38;2;205;154;34m⏸ plan\x1b[39m',
        },
      },
    ]);
  });
  await expect(page.locator('.extension-status')).toHaveText('⏸ plan');
  await input.fill('检查方案');
  await input.press('Enter');
  await page.getByRole('button', { name: '停止任务', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '发送消息', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).ipcCalls.some(
          (call: any) =>
            call.action?.type === 'extension_response' &&
            call.action.id === 'plan-stop' &&
            call.action.value.cancelled,
        ),
      ),
    )
    .toBe(true);
});

test('settings use native nested menus and remain inside the viewport', async ({
  page,
}) => {
  await mock(page);
  await page.goto('/');
  const input = page.getByRole('textbox', { name: '消息输入' });
  await expect(input).toBeEnabled();
  await input.fill('/settings');
  await input.press('Enter');
  await page.getByRole('option', { name: /自动压缩/ }).click();
  const menu = page.getByRole('listbox', { name: 'Pi 设置 / 自动压缩' });
  await expect(menu).toBeVisible();
  const bounds = await menu.boundingBox();
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(800);
  await page.screenshot({ path: 'test-results/inline-settings.png' });
  await menu.getByRole('option', { name: '关闭', exact: true }).click();
  await expect(
    page.getByRole('listbox', { name: '/settings · Pi 设置' }),
  ).toBeVisible();
  await page.getByRole('textbox', { name: '搜索菜单' }).press('Escape');
  await expect(input).toHaveValue('/settings');
  expect(
    await page.evaluate(() =>
      (window as any).ipcCalls.some(
        (call: any) =>
          call.action?.type === 'set_auto_compaction' &&
          call.action.enabled === false,
      ),
    ),
  ).toBe(true);
});

test('settings preserve conversation, retain failed edits and save across categories', async ({
  page,
}) => {
  await mock(page, 100);
  await page.goto('/');
  const input = page.getByRole('textbox', { name: '消息输入', exact: true });
  await expect(input).toBeEnabled();
  await input.fill('保留设置前的草稿');
  await page.locator('.transcript').evaluate((node) => {
    (window as any).savedTranscript = node;
    node.scrollTop = 100;
  });
  await page.keyboard.press('Control+,');
  const settings = page.getByRole('region', { name: '应用设置' });
  await expect(
    settings.getByRole('heading', { name: '设置', exact: true }),
  ).toBeFocused();
  await settings.getByRole('radio', { name: '深色', exact: true }).check();
  await page.screenshot({ path: 'test-results/settings-appearance-light.png' });
  await settings.getByRole('button', { name: 'Pi 连接', exact: true }).click();
  await settings
    .getByRole('textbox', { name: /Pi 入口路径/ })
    .fill('/custom/pi');
  await settings
    .getByRole('textbox', { name: /额外 PATH/ })
    .fill('/custom/bin\n\n/other/bin');
  await settings.getByRole('button', { name: '检测 Pi', exact: true }).click();
  await expect(settings.locator('.diagnostic-result')).toContainText(
    'unmocked IPC',
  );
  await settings
    .getByRole('button', { name: '会话与存储', exact: true })
    .click();
  await settings.getByRole('textbox', { name: /会话目录/ }).fill('/sessions');
  await settings.getByRole('button', { name: '返回对话', exact: true }).click();
  await expect(settings).toContainText('有未保存的更改，是否放弃');
  await settings.getByRole('button', { name: '继续编辑', exact: true }).click();
  await page.evaluate(() => {
    (window as any).failSaveOnce = true;
  });
  await settings.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(settings).toContainText('模拟保存失败');
  await expect(settings.getByRole('textbox', { name: /会话目录/ })).toHaveValue(
    '/sessions',
  );
  await settings.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(settings).toHaveCount(0);
  await expect(input).toHaveValue('保留设置前的草稿');
  await expect(input).toBeFocused();
  expect(
    await page
      .locator('.transcript')
      .evaluate((node) => node === (window as any).savedTranscript),
  ).toBe(true);
  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('mock-settings')!),
  );
  expect(saved).toMatchObject({
    theme: 'dark',
    piPath: '/custom/pi',
    sessionDir: '/sessions',
    extraPath: ['/custom/bin', '/other/bin'],
  });
  await page.reload();
  await page.keyboard.press('Control+,');
  await expect(
    settings.getByRole('radio', { name: '深色', exact: true }),
  ).toBeChecked();
  await page.screenshot({ path: 'test-results/settings-appearance-dark.png' });
  await page.setViewportSize({ width: 480, height: 720 });
  await expect(
    settings.getByRole('button', { name: '保存设置', exact: true }),
  ).toBeInViewport();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: 'test-results/settings-narrow.png' });
});

test('desktop zoom shortcuts invoke native WebView scaling', async ({
  page,
}) => {
  await mock(page);
  await page.addInitScript(() => {
    const host = window as any;
    host.isTauri = true;
    host.__TAURI_INTERNALS__.metadata = {
      currentWindow: { label: 'main' },
      currentWebview: { label: 'main' },
    };
    host.zoomCalls = [];
    const invoke = host.__TAURI_INTERNALS__.invoke;
    host.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
      if (command === 'plugin:webview|set_webview_zoom') {
        host.zoomCalls.push(args);
        return;
      }
      return invoke(command, args);
    };
  });
  await page.goto('/');
  await expect
    .poll(() => page.evaluate(() => (window as any).zoomCalls.at(-1)))
    .toEqual({ label: 'main', value: 1 });
  await page.keyboard.press('Control+=');
  await expect
    .poll(() => page.evaluate(() => (window as any).zoomCalls.at(-1)))
    .toEqual({ label: 'main', value: 1.1 });
  await page.keyboard.press('Control+0');
  await expect
    .poll(() => page.evaluate(() => (window as any).zoomCalls.at(-1)))
    .toEqual({ label: 'main', value: 1 });
});

test('interface zoom shortcuts persist, respect limits and work inside settings', async ({
  page,
}) => {
  await mock(page);
  await page.goto('/');
  const zoom = () =>
    page.evaluate(() => Number(document.documentElement.style.zoom));
  await expect.poll(zoom).toBe(1);
  await page.keyboard.press('Control+=');
  await expect.poll(zoom).toBe(1.1);
  await page.keyboard.press('Control+Shift+=');
  await expect.poll(zoom).toBe(1.2);
  await page.reload();
  await expect.poll(zoom).toBe(1.2);
  await page.keyboard.press('Control+,');
  await expect(page.getByRole('region', { name: '应用设置' })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: '界面缩放' })).toHaveCount(0);
  await page.keyboard.press('Control+-');
  await expect.poll(zoom).toBe(1.1);
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect.poll(zoom).toBe(1.1);
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('Control+-');
    await expect.poll(zoom).toBe(Math.max(0.8, 1 - i / 10));
  }
  for (let i = 0; i < 9; i++) {
    await page.keyboard.press('Control+=');
    await expect.poll(zoom).toBe(Math.min(1.5, (90 + i * 10) / 100));
  }
  await page.screenshot({ path: 'test-results/interface-zoom-150.png' });
  const shell = await page.locator('.app-shell').boundingBox();
  expect(shell!.height).toBeCloseTo(800, 0);
  await page.keyboard.press('Control+0');
  await expect.poll(zoom).toBe(1);
  await page.keyboard.press('Meta+=');
  await expect.poll(zoom).toBe(1.1);
  await page.keyboard.press('Meta+0');
  await expect.poll(zoom).toBe(1);
});

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
  expect(
    await page.evaluate(
      () =>
        (window as any).ipcCalls.filter((c: any) => c.command === 'connect_pi')
          .length,
    ),
  ).toBe(1);
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
test('creating a session in another project never remounts the old long transcript', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await mock(page, 300, true);
  await page.goto('/');
  await page
    .getByRole('region', { name: '最近', exact: true })
    .locator('.history-item')
    .filter({ hasText: '修复登录' })
    .click();
  const transcript = page.locator('.transcript');
  await expect(transcript).toBeVisible();
  await expect
    .poll(() =>
      transcript.evaluate(
        (node) => node.scrollHeight - node.clientHeight - node.scrollTop,
      ),
    )
    .toBeLessThan(3);
  await page.evaluate(() => {
    const host = window as any;
    host.deferConnection = true;
    host.slowSession = 'new-project.jsonl';
    host.historyMessages = [];
    host.transcriptMounts = 0;
    host.transcriptObserver = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (
            node instanceof Element &&
            (node.matches('.transcript') || node.querySelector('.transcript'))
          )
            host.transcriptMounts++;
        }
      }
    });
    host.transcriptObserver.observe(document.querySelector('.conversation'), {
      childList: true,
      subtree: true,
    });
  });
  await page
    .getByRole('button', { name: '在 C:/work/beta 中新建会话', exact: true })
    .click();
  await expect(page.locator('.session-title')).toHaveText('新对话');
  await expect(page.locator('.welcome p')).toHaveText('C:/work/beta');
  expect(
    await page.evaluate(
      () =>
        (window as any).ipcCalls.filter((call: any) =>
          ['new_session', 'new_project_session'].includes(call.action?.type),
        ).length,
    ),
  ).toBe(0);
  const input = page.getByRole('textbox', { name: '消息输入', exact: true });
  await expect(input).toBeEnabled();
  await input.fill('首条消息');
  await input.press('Enter');
  await expect(page.locator('.conversation')).toHaveAttribute(
    'aria-busy',
    'true',
  );
  await expect(transcript).toHaveCount(0);
  await expect(page.locator('.welcome')).toHaveCount(0);
  await expect(
    page.getByRole('textbox', { name: '消息输入', exact: true }),
  ).toBeDisabled();
  expect(
    await page.evaluate(
      () =>
        (window as any).ipcCalls.filter(
          (call: any) => call.command === 'connect_pi',
        ).length,
    ),
  ).toBe(1);
  await expect
    .poll(() => page.evaluate(() => typeof (window as any).releaseHistory))
    .toBe('function');
  await expect(transcript).toHaveCount(0);
  await expect(page.locator('.welcome')).toHaveCount(0);
  await page.evaluate(() => (window as any).releaseHistory());
  await expect(page.locator('.conversation')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  await expect(page.getByText('这是模拟回答。', { exact: true })).toBeVisible();
  const actions = await page.evaluate(() =>
    (window as any).ipcCalls
      .filter((call: any) => call.command === 'perform')
      .map((call: any) => call.action),
  );
  expect(
    actions.filter((action: any) => action.type === 'new_project_session'),
  ).toEqual([{ type: 'new_project_session', project: 'C:/work/beta' }]);
  expect(actions.filter((action: any) => action.type === 'prompt')).toEqual([
    { type: 'prompt', message: '首条消息' },
  ]);
  expect(
    await page.evaluate(() => {
      const host = window as any;
      host.transcriptObserver.disconnect();
      return host.transcriptMounts;
    }),
  ).toBe(1);
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
    .toBe(0);
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
  await projects.getByRole('button', { name: '显示全部 9 个项目' }).click();
  await expect(projects.locator('.project-current')).toHaveCount(9);
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
  ).toHaveLength(1);
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
  expect(calls).toEqual(['']);
  expect(await projectTree.locator('.project-name').allTextContents()).toEqual(
    originalOrder,
  );
  await page.keyboard.press('Control+,');
  await page.getByRole('radio', { name: '跟随系统', exact: true }).check();
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
test('recent and project sessions advance only after sending a message', async ({
  page,
}) => {
  await mock(page);
  await page.addInitScript(() => {
    (window as any).sessionCatalog = [
      {
        path: 'older.jsonl',
        id: 'older',
        cwd: 'C:/work/alpha',
        name: '较早发送',
        preview: '',
        timestamp: '2025-01-01',
        lastPromptAt: '2025-01-02T00:00:00.000Z',
        modified: 999,
        warning: null,
      },
      {
        path: 'newer.jsonl',
        id: 'newer',
        cwd: 'C:/work/alpha',
        name: '较近发送',
        preview: '',
        timestamp: '2025-01-01',
        lastPromptAt: '2025-02-01T00:00:00.000Z',
        modified: 1,
        warning: null,
      },
    ];
  });
  await page.goto('/');
  const recent = page.getByRole('region', { name: '最近', exact: true });
  const projects = page.getByRole('region', { name: '工作项目', exact: true });
  await projects.getByRole('button', { name: 'alpha 2', exact: true }).click();
  const recentRows = recent.locator('.history-item');
  const projectRows = projects.locator('.history-item');
  await expect(recentRows.first()).toHaveText('较近发送 alpha');
  await expect(projectRows.first()).toHaveText('较近发送');
  await projects.getByRole('button', { name: '较早发送', exact: true }).click();
  await expect(page.locator('.session-title')).toHaveText('较早发送');
  await expect(recentRows.first()).toHaveText('较近发送 alpha');
  await expect(projectRows.first()).toHaveText('较近发送');
  await page
    .getByRole('textbox', { name: '消息输入', exact: true })
    .fill('新的消息');
  await page
    .getByRole('textbox', { name: '消息输入', exact: true })
    .press('Enter');
  await expect(projectRows.first()).toHaveText('较早发送');
  await expect(recentRows.first()).toHaveText('较早发送 alpha');
});

test('projects support drag and keyboard reordering and retain order after reload', async ({
  page,
}) => {
  await mock(page, 2, true);
  await page.goto('/');
  const tree = page.getByRole('region', { name: '工作项目', exact: true });
  const alpha = tree.getByRole('button', { name: 'alpha 1', exact: true });
  const beta = tree.getByRole('button', { name: 'beta 1', exact: true });
  await expect(alpha).toHaveAttribute('draggable', 'true');
  const original = await tree.locator('.project-name').allTextContents();
  await beta.dragTo(alpha, { targetPosition: { x: 40, y: 4 } });
  await expect
    .poll(() => tree.locator('.project-name').allTextContents())
    .toEqual(['mock', 'beta', 'alpha']);
  await page.reload();
  await expect
    .poll(() => tree.locator('.project-name').allTextContents())
    .toEqual(['mock', 'beta', 'alpha']);
  await beta.focus();
  await page.keyboard.press('Alt+ArrowDown');
  await expect
    .poll(() => tree.locator('.project-name').allTextContents())
    .toEqual(original);
  await expect(beta).toBeFocused();
  await page.screenshot({ path: 'test-results/project-order-light.png' });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
  });
  await page.screenshot({ path: 'test-results/project-order-dark.png' });
  await page.reload();
  await expect
    .poll(() => tree.locator('.project-name').allTextContents())
    .toEqual(original);
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
  ).toEqual(['']);
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
  await expect(page.getByText('已连接', { exact: true })).toBeVisible();
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
  await expect(page.getByRole('region', { name: '应用设置' })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('region', { name: '应用设置' })).toHaveCount(0);
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
    (window as any).bodies = {
      'long-answer': 'a'.repeat(65536) + '剩余正文',
      'short-tool': '正文 short-tool',
      'long-tool': '正文 long-tool\n末尾工具正文',
    };
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
  // 折叠工具不展示正文，用消息标识定位，避免依赖尚未展开的内容。
  const shortTool = page.locator('[data-message-id="short-tool"]');
  await shortTool.locator('.tool-heading').click();
  await expect(
    shortTool.getByRole('button', { name: '分块查看完整输出' }),
  ).toHaveCount(0);
  const longTool = page.locator('[data-message-id="long-tool"]');
  await longTool.locator('.tool-heading').click();
  await expect(
    longTool.getByText('末尾工具正文', { exact: true }),
  ).toBeVisible();
  await expect(
    longTool.getByRole('button', { name: '分块查看完整输出' }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: '查看完整正文', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '下一块', exact: true }).click();
  await expect(dialog.locator('.full-content')).toHaveText('剩余正文');
  await expect(
    dialog.getByRole('button', { name: '已到末尾', exact: true }),
  ).toBeDisabled();
});
test('tool summaries expand inline with code, edit diff, parameters and truncation notices', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await mock(page, 0);
  await page.addInitScript(() => {
    const host = window as any;
    const diff = [
      ' 1 const keep = true;',
      '-2 const value = "old";',
      '+2 const value = "new";',
      ' 3 // context',
      ...Array.from(
        { length: 15 },
        (_, i) => `+${i + 3} const added${i} = true;`,
      ),
    ].join('\n');
    const shell = Array.from({ length: 12 }, (_, i) => `shell line ${i}`).join(
      '\n',
    );
    host.bodies = {
      read: 'const answer: number = 42;\n<script>alert("unsafe")</script>',
      diff,
      shell,
      write: '写入成功',
      written: 'const written = true;',
      args: '{"path":"src/new.ts"}',
    };
    const message = (id: string, name: string, text: string, tool: object) => ({
      id,
      role: 'toolResult',
      name,
      text,
      thinking: '',
      status: 'done',
      contentRef: id,
      truncated: false,
      tool: { callId: id, name, ...tool },
    });
    host.historyMessages = [
      message('read', 'read', host.bodies.read, {
        path: 'src/read.ts',
        offset: 10,
        limit: 2,
        outputLines: 2,
      }),
      message('edit', 'edit', '编辑成功', {
        path: 'src/edit.ts',
        diffRef: 'diff',
        diffPreview: diff.split('\n').slice(0, 10).join('\n'),
        diffLines: 19,
        addedLines: 16,
        removedLines: 1,
        outputLines: 1,
      }),
      message('shell', 'bash', shell, {
        command: 'echo "hello"',
        tail: shell.split('\n').slice(-5).join('\n'),
        outputLines: 12,
        truncation: {
          truncated: true,
          truncatedBy: 'lines',
          outputLines: 12,
          totalLines: 99,
        },
        fullOutputPath: 'C:/tmp/full.txt',
      }),
      message('write', 'write', '写入成功', {
        path: 'src/new.ts',
        writeRef: 'written',
        addedLines: 1,
        removedLines: 0,
        argsRef: 'args',
        outputLines: 1,
      }),
    ];
  });
  await page.goto('/');
  await page
    .getByRole('button', { name: '选择项目文件夹', exact: true })
    .last()
    .click();
  const read = page
    .locator('.tool-step')
    .filter({ has: page.locator('.tool-path', { hasText: 'src/read.ts' }) });
  await expect(read.locator('.tool-code')).toHaveCount(0);
  // 先模拟用户上滚退出底部跟随，避免 WebKit 的自动滚入与跟随帧争夺位置。
  await page.locator('.transcript').hover();
  await page.mouse.wheel(0, -240);
  await page.locator('.transcript').evaluate((node) => {
    node.scrollTop = 0;
  });
  await read.locator('.tool-heading').click();
  await expect(read.locator('.hljs-keyword').first()).toBeVisible();
  await expect(read.locator('.tool-code')).toContainText(
    '<script>alert("unsafe")</script>',
  );
  expect(
    await page.evaluate(
      () => document.querySelectorAll('.tool-step script').length,
    ),
  ).toBe(0);
  const edit = page
    .locator('.tool-step')
    .filter({ has: page.locator('.tool-path', { hasText: 'src/edit.ts' }) });
  await expect(edit.locator('.tool-code')).toHaveCount(0);
  await expect(edit.locator('.change-added')).toHaveText('+16');
  await expect(edit.locator('.change-removed')).toHaveText('−1');
  const view = edit.getByRole('button', { name: '查看变更', exact: true });
  await view.click();
  const panel = page.getByRole('complementary', { name: '代码变更' });
  await expect(panel.locator('.diff-removed mark')).toHaveText('old');
  await expect(panel.locator('.diff-added mark')).toHaveText('new');
  await expect(panel).toContainText('+17 const added14 = true;');
  await panel.getByRole('button', { name: '关闭变更' }).click();
  await expect(view).toBeFocused();
  const shell = page
    .locator('.tool-step')
    .filter({ has: page.locator('.tool-name', { hasText: /^bash$/ }) });
  await expect(shell.locator('.tool-code')).toHaveCount(0);
  await expect(shell.locator('.tool-command')).toHaveText('echo "hello"');
  await expect(shell.locator('.tool-warning')).toHaveCount(0);
  await shell.locator('.tool-heading').click();
  await expect(shell.getByText('shell line 0', { exact: true })).toBeVisible();
  await expect(shell.locator('.tool-warning').first()).toContainText('12 / 99');
  const write = page
    .locator('.tool-step')
    .filter({ has: page.locator('.tool-path', { hasText: 'src/new.ts' }) });
  await expect(write.locator('.tool-toggle-label')).toHaveCount(0);
  await write.getByRole('button', { name: '查看变更', exact: true }).click();
  await expect(write.locator('.change-added')).toHaveText('+1');
  await expect(write.locator('.change-removed')).toHaveText('−0');
  await expect(panel).toContainText('新增内容');
  await expect(panel).not.toContainText('缺少修改前版本');
  await expect(panel.locator('.language-typescript .hljs-keyword')).toHaveText(
    'const',
  );
  await panel.getByRole('button', { name: '关闭变更' }).click();
  await expect(write.locator('.tool-expanded')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/tools-light.png' });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
  });
  await page.screenshot({ path: 'test-results/tools-dark.png' });
  expect(errors).toEqual([]);
});

test('large tool output retries and reads explicit chunks in its own scroll box', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await mock(page, 0);
  await page.addInitScript(() => {
    const host = window as any;
    const text =
      Array.from({ length: 1200 }, (_, i) => `${i}: ${'x'.repeat(160)}`).join(
        '\n',
      ) + '\n最后一行';
    host.bodies = { large: text };
    host.failContentOnce = 'large';
    host.historyMessages = [
      {
        id: 'large',
        role: 'toolResult',
        name: 'custom',
        text: text.slice(0, 65536),
        thinking: '',
        status: 'done',
        contentRef: 'large',
        truncated: true,
        tool: { callId: 'large', name: 'custom', outputLines: 1201 },
      },
    ];
  });
  await page.goto('/');
  await page
    .getByRole('button', { name: '选择项目文件夹', exact: true })
    .last()
    .click();
  const tool = page.locator('.tool-step');
  await tool.locator('.tool-heading').click();
  await expect(tool.getByRole('alert')).toContainText('模拟正文读取失败');
  await tool.getByRole('button', { name: '重试读取', exact: true }).click();
  await expect(tool.locator('.tool-expanded .tool-code')).toBeVisible();
  while (
    await tool
      .getByRole('button', { name: '继续加载输出', exact: true })
      .count()
  ) {
    await tool
      .getByRole('button', { name: '继续加载输出', exact: true })
      .click();
  }
  await expect(tool).toContainText('已到末尾');
  await page.locator('.transcript').evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await expect(tool.getByText('最后一行', { exact: true })).toBeVisible();
  await tool.locator('.tool-expanded .tool-code').evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  expect(await tool.locator('.tool-code-line').count()).toBe(1201);
  await tool.locator('.tool-heading').click();
  await expect(tool.locator('.tool-expanded')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('tool expansion survives scrolling and updates from running to complete', async ({
  page,
}) => {
  await mock(page, 0);
  await page.addInitScript(() => {
    const host = window as any;
    const tool = {
      id: 'live-tool',
      role: 'toolResult',
      name: 'bash',
      text: 'partial',
      thinking: '',
      status: 'running',
      contentRef: null,
      tool: {
        callId: 'live-tool',
        name: 'bash',
        command: 'echo output',
        tail: 'partial',
        outputLines: 1,
      },
    };
    host.liveTool = tool;
    host.bodies = { finished: 'completed output' };
    host.historyMessages = [
      ...Array.from({ length: 80 }, (_, i) => ({
        id: `m${i}`,
        role: 'user',
        text: `previous ${i}`,
        thinking: '',
        status: 'done',
        contentRef: null,
        name: null,
      })),
      tool,
    ];
  });
  await page.goto('/');
  await page
    .getByRole('button', { name: '选择项目文件夹', exact: true })
    .last()
    .click();
  const tool = page.locator('.tool-step');
  await expect(tool.locator('.tool-state')).toHaveText('执行中');
  await tool.locator('.tool-heading').click();
  await page.evaluate(() => {
    const host = window as any;
    host.emitEvents([
      {
        type: 'message',
        message: {
          ...host.liveTool,
          status: 'done',
          text: 'completed output',
          contentRef: 'finished',
          tool: { ...host.liveTool.tool, tail: 'completed output' },
        },
      },
    ]);
  });
  await expect(tool.locator('.tool-state')).toHaveText('已完成');
  await expect(
    tool.getByRole('region', { name: '工具正文', exact: true }),
  ).toContainText('completed output');
  const transcript = page.getByRole('region', {
    name: '对话消息',
    exact: true,
  });
  await transcript.hover();
  await page.mouse.wheel(0, -1000);
  await transcript.evaluate((node) => {
    node.scrollTop = 0;
  });
  await expect(tool).toHaveCount(1);
  await expect(
    page.getByRole('button', { name: '回到底部', exact: true }),
  ).toBeVisible();
  await transcript.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await expect(tool.locator('.tool-heading')).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  await expect(
    tool.getByRole('region', { name: '工具正文', exact: true }),
  ).toContainText('completed output');
});

test('queued guidance is visible immediately and is replaced when Pi consumes it, with a filled stop button', async ({
  page,
}) => {
  await mock(page, 0);
  await page.goto('/');
  await page
    .getByRole('button', { name: '选择项目文件夹', exact: true })
    .last()
    .click();
  await page.evaluate(() => {
    const host = window as any;
    host.holdRun = true;
    host.queuePrompts = true;
  });
  const input = page.getByRole('textbox', { name: '消息输入', exact: true });
  await input.fill('开始长任务');
  await input.press('Enter');
  const stop = page.getByRole('button', { name: '停止任务', exact: true });
  await expect(stop).toBeVisible();
  expect(
    await stop.evaluate((node) => getComputedStyle(node).backgroundColor),
  ).not.toBe('rgba(0, 0, 0, 0)');
  await input.fill('先修复登录，再处理样式');
  await input.press('Enter');
  const row = page
    .locator('.message.user')
    .filter({ hasText: '先修复登录，再处理样式' });
  await expect(row).toHaveCount(1);
  await expect(row.locator('.delivery-status')).toHaveText(
    '引导消息 · 等待处理',
  );
  await page.evaluate(() => {
    (window as any).emitEvents([
      {
        type: 'message',
        message: {
          id: 'consumed-guidance',
          role: 'user',
          text: '先修复登录，再处理样式',
          thinking: '',
          status: 'done',
          contentRef: null,
          name: null,
        },
      },
    ]);
  });
  await expect(row).toHaveCount(1);
  await expect(row.locator('.delivery-status')).toHaveCount(0);
  await expect(stop).toBeVisible();
});

test('running tasks accept direct steering and follow-up messages without stopping', async ({
  page,
}) => {
  await mock(page, 0);
  await page.goto('/');
  await page
    .getByRole('button', { name: '选择项目文件夹', exact: true })
    .last()
    .click();
  await page.evaluate(() => {
    (window as any).holdRun = true;
  });
  const input = page.getByRole('textbox', { name: '消息输入', exact: true });
  await input.fill('开始长任务');
  await input.press('Enter');
  await expect(
    page.getByRole('button', { name: '停止任务', exact: true }),
  ).toBeVisible();
  await expect(input).toBeEnabled();
  await input.fill('先处理登录问题');
  await input.press('Enter');
  await expect(input).toHaveValue('');
  await expect(page.getByText('引导消息已提交', { exact: true })).toBeVisible();
  await input.fill('增加测试覆盖');
  await page.getByRole('button', { name: '发送引导', exact: true }).click();
  await expect(input).toHaveValue('');
  await input.fill('完成后检查文档');
  await page.getByRole('button', { name: '完成后发送', exact: true }).click();
  await expect(input).toHaveValue('');
  await expect(
    page.getByRole('button', { name: '停止任务', exact: true }),
  ).toBeVisible();
  const actions = await page.evaluate(() =>
    (window as any).ipcCalls
      .filter((call: any) => call.command === 'perform')
      .map((call: any) => call.action),
  );
  expect(
    actions
      .filter((action: any) => action.type === 'prompt')
      .map((action: any) => action.mode),
  ).toEqual([undefined, 'steer', 'steer', 'followUp']);
  expect(actions.some((action: any) => action.type === 'stop')).toBe(false);
});

test('long tool output scrolls independently and contains boundary gestures', async ({
  page,
}) => {
  await mock(page, 0);
  await page.addInitScript(() => {
    (window as any).historyMessages = Array.from({ length: 40 }, (_, i) => ({
      id: String(i),
      role: 'toolResult',
      name: 'bash',
      thinking: '',
      status: 'done',
      contentRef: null,
      text: 'line\n'.repeat(600),
      tool: {
        callId: String(i),
        name: 'bash',
        command: 'echo output',
        tail: 'line',
        outputLines: 600,
      },
    }));
  });
  await page.goto('/');
  const tool = page.locator('.tool-step').last();
  await tool.locator('.tool-heading').click();
  const code = tool.locator('.tool-expanded .tool-code');
  await code.hover();
  const root = page.locator('.transcript');
  const top = await root.evaluate((node) => node.scrollTop);
  await page.mouse.wheel(0, 240);
  await expect
    .poll(() => code.evaluate((node) => node.scrollTop))
    .toBeGreaterThan(100);
  expect(await root.evaluate((node) => node.scrollTop)).toBe(top);
  await code.evaluate((node) => {
    node.scrollTop = 0;
  });
  await page.mouse.wheel(0, -240);
  await page.waitForTimeout(150);
  expect(await root.evaluate((node) => node.scrollTop)).toBe(top);
});

for (const kind of ['many lines', 'few wrapped lines', 'virtual rows']) {
  test(`expanded code keeps collapse accessible with ${kind}`, async ({
    page,
  }) => {
    await mock(page, 0);
    await page.addInitScript((kind) => {
      const host = window as any;
      const text =
        kind === 'few wrapped lines'
          ? Array.from(
              { length: 3 },
              (_, i) => `${i}: ${'长文本abcdef'.repeat(800)}`,
            ).join('\n')
          : Array.from(
              { length: kind === 'virtual rows' ? 600 : 180 },
              (_, i) => `const line${i} = ${i};`,
            ).join('\n');
      host.bodies = { sticky: text };
      host.historyMessages = [
        // 工具位于真实对话后段，必须覆盖虚拟消息项的非零纵向偏移。
        ...Array.from({ length: 40 }, (_, i) => ({
          id: `before-sticky-${i}`,
          role: 'user',
          text: `之前的消息 ${i}`,
          thinking: '',
          status: 'done',
          contentRef: null,
          name: null,
        })),
        {
          id: 'sticky',
          role: 'toolResult',
          name: 'read',
          text,
          thinking: '',
          status: 'done',
          contentRef: 'sticky',
          tool: {
            callId: 'sticky',
            name: 'read',
            path: 'src/sticky.ts',
            outputLines:
              kind === 'few wrapped lines'
                ? 3
                : kind === 'virtual rows'
                  ? 600
                  : 180,
          },
        },
      ];
    }, kind);
    await page.goto('/');
    await page
      .getByRole('button', { name: '选择项目文件夹', exact: true })
      .last()
      .click();
    const transcript = page.getByRole('region', {
      name: '对话消息',
      exact: true,
    });
    const heading = page.locator('.tool-heading');
    await heading.click();
    await expect(page.locator('.tool-code-line')).toHaveCount(
      kind === 'few wrapped lines' ? 3 : kind === 'virtual rows' ? 600 : 180,
    );
    const code = page.locator('.tool-expanded .tool-code');
    for (const width of [1200, 480]) {
      await page.setViewportSize({ width, height: 900 });
      const backdrop = page.getByRole('button', {
        name: '收起侧栏',
        exact: true,
      });
      if (await backdrop.isVisible()) await backdrop.click();
      // 按真实几何位置滚到正文中段，禁止测试自动寻找标题掩盖吸顶失效。
      await code.evaluate((node) => {
        node.scrollTop = (node.scrollHeight - node.clientHeight) / 2;
        const area = node.closest('.transcript')!;
        area.scrollTop = area.scrollHeight;
      });
      await expect
        .poll(() => code.evaluate((node) => node.scrollTop))
        .toBeGreaterThan(0);
      await expect(heading).toBeInViewport({ ratio: 1 });
      await expect
        .poll(() =>
          heading.evaluate((node) => {
            const rect = node.getBoundingClientRect();
            const hit = document.elementFromPoint(
              rect.right - 20,
              rect.top + rect.height / 2,
            );
            return node.contains(hit);
          }),
        )
        .toBe(true);
    }
    await expect(heading).toBeInViewport();
    await expect(heading.locator('.tool-toggle-label')).toHaveText('收起详情');
    await heading.click();
    await expect(heading).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('.tool-expanded')).toHaveCount(0);
    await expect(heading).toBeFocused();
    await expect(heading).toBeInViewport();
    await heading.click();
    const collapse = page.getByRole('button', {
      name: '收起输出',
      exact: true,
    });
    // 末尾按钮保持普通布局，仅在真正读到末尾时出现。
    await transcript.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    await expect(collapse).toBeInViewport({ ratio: 1 });
    // 命中测试确保按钮没有被正文或输入区覆盖，也不让 click 自动滚动掩盖问题。
    await expect
      .poll(() =>
        collapse.evaluate((node) => {
          const rect = node.getBoundingClientRect();
          return node.contains(
            document.elementFromPoint(
              rect.x + rect.width / 2,
              rect.y + rect.height / 2,
            ),
          );
        }),
      )
      .toBe(true);
    await collapse.click({ trial: true });
    await collapse.focus();
    await collapse.press('Enter');
    await expect(heading).toHaveAttribute('aria-expanded', 'false');
    await expect(heading).toBeFocused();
    await expect(heading).toBeInViewport();
  });
}

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
for (const deferred of [false, true]) {
  test(`switching sessions keeps reading anchors stable with ${deferred ? 'deferred' : 'inline'} history`, async ({
    page,
  }) => {
    await mock(page, 2, true);
    await page.goto('/');
    const recent = page.getByRole('region', { name: '最近', exact: true });
    await recent.locator('[data-sidebar-path="alpha.jsonl"]').click();
    await page.evaluate((deferred) => {
      const host = window as any;
      host.bodies = {};
      // 模拟正文缓存淘汰后的按需重载，让高度变化确实发生在向上滚动期间。
      const invoke = host.__TAURI_INTERNALS__.invoke;
      host.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
        if (command === 'read_content')
          await new Promise((resolve) => setTimeout(resolve, 80));
        return invoke(command, args);
      };
      host.historyMessages = Array.from({ length: 160 }, (_, i) => ({
        id: `variable-${i}`,
        role: i % 3 !== 0 ? 'toolResult' : 'assistant',
        text:
          i % 3 !== 0
            ? `输出 ${i}\nline 2\nline 3`
            : `回答 ${i}\n\n` +
              Array.from(
                { length: 1 + (i % 4) },
                (_, j) =>
                  `段落 ${j}：${'这是用于检查历史阅读锚点的中文正文。'.repeat(2)}`,
              ).join('\n\n'),
        tool:
          i % 3 !== 0
            ? {
                callId: `variable-${i}`,
                name: 'bash',
                command: `echo ${i}`,
                tail: `输出 ${i}\nline 2\nline 3`,
                outputLines: 3,
              }
            : undefined,
        thinking: '',
        status: 'done',
        contentRef: null,
        name: null,
      })).map((message: any) => {
        if (deferred && message.role === 'assistant') {
          host.bodies[message.id] = message.text;
          message.contentRef = message.id;
          message.text = '';
        }
        return message;
      });
    }, deferred);
    await recent.locator('[data-sidebar-path="beta.jsonl"]').click();
    await expect(page.locator('.session-title')).toHaveText('添加测试');
    const transcript = page.locator('.transcript');
    await expect
      .poll(() =>
        transcript.evaluate(
          (node) => node.scrollHeight - node.scrollTop - node.clientHeight,
        ),
      )
      .toBeLessThan(3);
    await expect(
      page.locator('.message-item[data-message-id="variable-159"]'),
    ).toContainText('回答 159');
    await expect
      .poll(() =>
        transcript.evaluate(
          (node) => node.scrollHeight - node.scrollTop - node.clientHeight,
        ),
      )
      .toBeLessThan(3);
    const area = (await transcript.boundingBox())!;
    await page.mouse.move(area.x + 4, area.y + area.height / 2);
    // 检查每帧正文坐标，而非只检查最终 scrollTop；否则一帧跳动后恢复会被漏掉。
    for (let step = 0; step < 16; step++) {
      await transcript.evaluate((node) => {
        const host = window as any;
        const edge = node.getBoundingClientRect().top;
        const anchor = Array.from(
          node.querySelectorAll<HTMLElement>('.message-item'),
        ).find((item) => item.getBoundingClientRect().bottom > edge + 40)!;
        const top = anchor.getBoundingClientRect().top;
        host.anchorSamples = [];
        host.anchorDone = false;
        let frames = 0;
        const sample = () => {
          host.anchorSamples.push({
            index: anchor.dataset.index,
            shift: anchor.getBoundingClientRect().top - top,
            scroll: node.scrollTop,
          });
          if (++frames < 20) requestAnimationFrame(sample);
          else host.anchorDone = true;
        };
        requestAnimationFrame(sample);
      });
      await page.mouse.wheel(0, -240);
      await page.waitForFunction(() => (window as any).anchorDone);
      const samples = await page.evaluate(
        () =>
          (window as any).anchorSamples as {
            index: string;
            shift: number;
            scroll: number;
          }[],
      );
      expect(
        Math.max(...samples.map((s) => s.shift)),
        JSON.stringify({ step, samples }),
      ).toBeLessThanOrEqual(242);
      expect(
        Math.min(...samples.map((s) => s.shift)),
        JSON.stringify({ step, samples }),
      ).toBeGreaterThanOrEqual(-2);
      expect(
        samples.at(-1)!.shift,
        JSON.stringify({ step, samples }),
      ).toBeCloseTo(240, 0);
    }
    await expect(
      page.getByRole('button', { name: '回到底部', exact: true }),
    ).toBeVisible();
  });
}

test('growing a message across the viewport edge preserves its reading position', async ({
  page,
}) => {
  await mock(page, 0);
  await page.addInitScript(() => {
    const host = window as any;
    host.growingMessage = {
      id: 'growing',
      role: 'assistant',
      status: 'streaming',
      text: Array.from({ length: 100 }, (_, i) => `正在阅读的第 ${i} 行`).join(
        '\n',
      ),
      thinking: '',
      contentRef: null,
      name: null,
    };
    host.historyMessages = [host.growingMessage];
  });
  await page.goto('/');
  const transcript = page.locator('.transcript');
  await expect
    .poll(() =>
      transcript.evaluate(
        (node) => node.scrollHeight - node.scrollTop - node.clientHeight,
      ),
    )
    .toBeLessThan(3);
  await transcript.hover();
  await page.mouse.wheel(0, -240);
  await expect(
    page.getByRole('button', { name: '回到底部', exact: true }),
  ).toBeVisible();
  // wheel 返回时原生滚动可能尚未执行；先等手势落地，再记录追加正文前的锚点。
  await expect
    .poll(() =>
      transcript.evaluate(
        (node) => node.scrollHeight - node.scrollTop - node.clientHeight,
      ),
    )
    .toBeGreaterThan(230);
  const content = page.locator('.streaming-text');
  const before = await content.evaluate((node) => ({
    top: node.getBoundingClientRect().top,
    height: node.getBoundingClientRect().height,
  }));
  expect(before.top).toBeLessThan((await transcript.boundingBox())!.y);
  await page.evaluate(() => {
    const host = window as any;
    host.emitEvents([
      {
        type: 'message',
        message: {
          ...host.growingMessage,
          text: host.growingMessage.text + '\n' + '追加正文\n'.repeat(50),
        },
      },
    ]);
  });
  await expect
    .poll(() => content.evaluate((node) => node.getBoundingClientRect().height))
    .toBeGreaterThan(before.height + 500);
  // 覆盖 ResizeObserver 交付和后续跟随帧，不能只在正文刚更新时断言。
  await content.evaluate(
    () =>
      new Promise<void>((resolve) => {
        let frames = 0;
        const sample = () =>
          ++frames === 12 ? resolve() : requestAnimationFrame(sample);
        requestAnimationFrame(sample);
      }),
  );
  expect(
    await content.evaluate((node) => node.getBoundingClientRect().top),
  ).toBeCloseTo(before.top, 0);
});

test('large histories initially mount only the latest server page', async ({
  page,
}) => {
  await mock(page, 10000);
  await page.goto('/');
  await expect(page.locator('.message-item')).toHaveCount(50);
  await expect(page.locator('.message-item').last()).toContainText('消息 9999');
  await expect(page.locator('.virtual-item, .virtual-space')).toHaveCount(0);
});

test('sidebar context menus rename, archive and restore projects and sessions across reload', async ({
  page,
}) => {
  await mock(page, 2, true);
  await page.goto('/');
  const tree = page.getByRole('region', { name: '工作项目', exact: true });
  let alpha = tree.locator(
    '[data-sidebar-kind="project"][data-sidebar-path="C:/work/alpha"]',
  );
  await alpha.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '重命名', exact: true }).click();
  await page
    .getByRole('textbox', { name: '重命名项目', exact: true })
    .fill('核心项目');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(alpha).toContainText('核心项目');
  if ((await alpha.getAttribute('aria-expanded')) === 'false')
    await alpha.click();
  const session = tree.locator(
    '[data-sidebar-kind="session"][data-sidebar-path="alpha.jsonl"]',
  );
  await session.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '重命名', exact: true }).click();
  await page
    .getByRole('textbox', { name: '重命名会话', exact: true })
    .fill('排查登录');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(session).toContainText('排查登录');
  await session.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '归档', exact: true }).click();
  await expect(session).toHaveCount(0);
  await page.reload();
  await page.getByRole('button', { name: '已归档', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const archive = page.getByRole('region', { name: '已归档', exact: true });
  await expect(archive).toContainText('排查登录');
  await archive
    .getByRole('button', { name: '恢复会话 排查登录', exact: true })
    .click();
  await page.getByRole('button', { name: '返回对话', exact: true }).click();
  await alpha.click({ button: 'right' });
  await expect(
    page.getByRole('menuitem', { name: '移入回收站', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('menuitem', { name: '归档', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(alpha).toHaveCount(0);
  await page.reload();
  await expect(alpha).toHaveCount(0);
  await page.getByRole('button', { name: '已归档', exact: true }).click();
  const trash = page.getByRole('region', { name: '已归档', exact: true });
  await expect(trash).toContainText('核心项目');
  await trash
    .getByRole('button', { name: '恢复项目 核心项目', exact: true })
    .click();
  await page.getByRole('button', { name: '返回对话', exact: true }).click();
  await expect(alpha).toContainText('核心项目');
  await alpha.click({ button: 'right' });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
});

test('sidebar navigation selects only the visible page and protects unsaved settings', async ({
  page,
}) => {
  await mock(page, 2, true);
  await page.goto('/');
  const archiveButton = page.getByRole('button', {
    name: '已归档',
    exact: true,
  });
  const settingsButton = page
    .locator('.sidebar-footer')
    .getByRole('button', { name: /设置/ });
  const settings = page.getByRole('region', { name: '应用设置' });
  await archiveButton.click();
  await expect(archiveButton).toHaveAttribute('aria-current', 'page');
  await settingsButton.click();
  await expect(settings).toBeVisible();
  await expect(archiveButton).not.toHaveAttribute('aria-current', 'page');
  await expect(settingsButton).toHaveAttribute('aria-current', 'page');
  await archiveButton.click();
  await expect(settings).toHaveCount(0);
  await expect(archiveButton).toHaveAttribute('aria-current', 'page');
  await settingsButton.click();
  await settings.getByRole('radio', { name: '深色', exact: true }).check();
  await archiveButton.click();
  await expect(settings).toContainText('有未保存的更改，是否放弃');
  await expect(settingsButton).toHaveAttribute('aria-current', 'page');
  await expect(archiveButton).not.toHaveAttribute('aria-current', 'page');
  await settings.getByRole('button', { name: '继续编辑', exact: true }).click();
  await expect(
    settings.getByRole('radio', { name: '深色', exact: true }),
  ).toBeChecked();
  await archiveButton.click();
  await settings
    .getByRole('button', { name: '放弃并继续', exact: true })
    .click();
  await expect(settings).toHaveCount(0);
  await expect(archiveButton).toHaveAttribute('aria-current', 'page');
  await settingsButton.click();
  await page
    .getByRole('region', { name: '最近', exact: true })
    .locator('[data-sidebar-path="alpha.jsonl"]')
    .click();
  await expect(settings).toHaveCount(0);
  await expect(page.locator('.conversation-workspace')).toBeVisible();
  await settingsButton.click();
  await page
    .getByRole('button', { name: /新对话/ })
    .first()
    .click();
  await expect(settings).toHaveCount(0);
  await expect(
    page.getByRole('textbox', { name: '消息输入', exact: true }),
  ).toBeVisible();
});

test('sidebar progressively reveals long recent and project lists', async ({
  page,
}) => {
  await mock(page, 2, true);
  await page.addInitScript(() => {
    (window as any).sessionCatalog = Array.from({ length: 45 }, (_, i) => ({
      path: `long-${i}.jsonl`,
      id: `long-${i}`,
      cwd: 'C:/work/alpha',
      name: `长列表会话 ${i}`,
      preview: '',
      timestamp: '',
      modified: i,
      warning: null,
    }));
  });
  await page.goto('/');
  const recent = page.getByRole('region', { name: '最近', exact: true });
  await expect(recent.locator('.history-item')).toHaveCount(20);
  await recent
    .getByRole('button', { name: '显示更多会话（剩余 25）', exact: true })
    .click();
  await expect(recent.locator('.history-item')).toHaveCount(40);
  const projects = page.getByRole('region', { name: '工作项目', exact: true });
  const alpha = projects.locator(
    '[data-sidebar-kind="project"][data-sidebar-path="C:/work/alpha"]',
  );
  if ((await alpha.getAttribute('aria-expanded')) === 'false')
    await alpha.click();
  await expect(projects.locator('.history-item')).toHaveCount(20);
  await projects
    .getByRole('button', { name: '显示更多会话（剩余 25）', exact: true })
    .click();
  await expect(projects.locator('.history-item')).toHaveCount(40);
});

test('sidebar restores focus when cancelling a pin or closing the drawer', async ({
  page,
}) => {
  await mock(page, 2, true);
  await page.goto('/');
  const recent = page.getByRole('region', { name: '最近', exact: true });
  await recent
    .getByRole('button', { name: '置顶 修复登录', exact: true })
    .click();
  const pinned = page.getByRole('region', { name: '置顶', exact: true });
  const unpin = pinned.getByRole('button', {
    name: '取消置顶 修复登录',
    exact: true,
  });
  await unpin.focus();
  await unpin.press('Enter');
  await expect(pinned.locator('.section-toggle')).toBeFocused();
  await page.setViewportSize({ width: 800, height: 700 });
  await page.getByRole('textbox', { name: '搜索历史会话' }).focus();
  await page.keyboard.press('Escape');
  const open = page.getByRole('button', { name: '展开侧栏', exact: true });
  await expect(open).toBeFocused();
  await open.press('Enter');
  await expect(
    page.getByRole('textbox', { name: '搜索历史会话' }),
  ).toBeFocused();
  await expect(
    page.getByRole('button', { name: '已归档', exact: true }),
  ).toBeVisible();
});

test('sidebar search preserves folds and exposes inline actions with keyboard focus', async ({
  page,
}) => {
  await mock(page, 2, true);
  await page.goto('/');
  const recent = page.getByRole('region', { name: '最近', exact: true });
  const toggle = recent.locator('.section-toggle');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  const search = page.getByRole('textbox', { name: '搜索历史会话' });
  await search.fill('修复');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await page.getByRole('button', { name: '清除会话搜索' }).click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await page.reload();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  const more = recent.getByRole('button', {
    name: '会话操作 修复登录',
    exact: true,
  });
  await more.click();
  await page.getByRole('menuitem', { name: '重命名', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const rename = page.getByRole('textbox', { name: '重命名会话', exact: true });
  await expect(rename).toBeFocused();
  await rename.press('Escape');
  await expect(
    recent.locator('[data-sidebar-path="alpha.jsonl"]'),
  ).toBeFocused();
  await search.fill('没有这种会话');
  await expect(page.locator('.history-list .history-empty')).toHaveCount(1);
  await expect(
    page.getByRole('button', { name: '已归档', exact: true }),
  ).toBeVisible();
});

test('history management preserves transcript and draft, filters and restores keyboard focus with undo', async ({
  page,
}) => {
  await mock(page, 2, true);
  await page.goto('/');
  const recent = page.getByRole('region', { name: '最近', exact: true });
  const session = recent.locator('[data-sidebar-path="alpha.jsonl"]');
  await session.click();
  const input = page.getByRole('textbox', { name: '消息输入', exact: true });
  await input.fill('保留草稿');
  await page.locator('.transcript').evaluate((node) => {
    (window as any).savedTranscript = node;
  });
  await session.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '归档', exact: true }).click();
  await page.getByRole('button', { name: '已归档', exact: true }).click();
  const archive = page.getByRole('region', { name: '已归档', exact: true });
  await expect(archive.getByRole('heading', { level: 1 })).toBeFocused();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await archive
    .getByRole('textbox', { name: '搜索已归档', exact: true })
    .fill('不存在');
  await expect(archive).toContainText('没有匹配的内容');
  await archive.getByRole('button', { name: '清除筛选', exact: true }).click();
  await archive.getByRole('button', { name: /^项目 \d+$/ }).click();
  await expect(archive).toContainText('没有匹配的内容');
  await archive.getByRole('button', { name: /^会话 \d+$/ }).click();
  const restore = archive.getByRole('button', {
    name: '恢复会话 修复登录',
    exact: true,
  });
  await restore.focus();
  await page.keyboard.press('Enter');
  await expect(archive).toContainText('还没有归档内容');
  await expect(archive.getByRole('heading', { level: 1 })).toBeFocused();
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(restore).toBeVisible();
  await archive.getByRole('button', { name: '返回对话', exact: true }).click();
  await expect(input).toHaveValue('保留草稿');
  expect(
    await page
      .locator('.transcript')
      .evaluate((node) => node === (window as any).savedTranscript),
  ).toBe(true);
  await page.getByRole('button', { name: '已归档', exact: true }).click();
  await expect(
    page.getByRole('region', { name: '已归档', exact: true }),
  ).toContainText('修复登录');
  await page.screenshot({ path: 'test-results/history-management-light.png' });
});

test('history management explains hidden parents and keeps failed restores retryable on narrow screens', async ({
  page,
}) => {
  await mock(page, 2, true);
  await page.goto('/');
  await page.evaluate(() => {
    localStorage.setItem(
      'mock-settings',
      JSON.stringify({
        sidebarItems: [
          { kind: 'project', path: 'C:/work/alpha', state: 'deleted' },
          { kind: 'session', path: 'alpha.jsonl', state: 'archived' },
        ],
      }),
    );
  });
  await page.reload();
  await page.getByRole('button', { name: '已归档', exact: true }).click();
  const archive = page.getByRole('region', { name: '已归档', exact: true });
  await expect(archive).toContainText('所属项目已归档');
  await page.evaluate(() => {
    (window as any).failSaveOnce = true;
  });
  const restore = archive.getByRole('button', {
    name: '恢复会话 修复登录',
    exact: true,
  });
  await restore.click();
  await expect(page.getByRole('alert')).toContainText('模拟保存失败');
  await expect(restore).toBeEnabled();
  await restore.click();
  await expect(
    page.getByRole('status').filter({ hasText: '所属项目仍被隐藏' }),
  ).toBeVisible();
  await page.getByRole('button', { name: '已归档', exact: true }).click();
  await page.setViewportSize({ width: 600, height: 720 });
  await page.locator('.sidebar-brand button').click();
  const trash = page.getByRole('region', { name: '已归档', exact: true });
  await expect(
    trash.getByRole('button', { name: '恢复项目 alpha', exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
  });
  await page.screenshot({
    path: 'test-results/history-management-dark-narrow.png',
  });
  await trash
    .getByRole('button', { name: '恢复项目 alpha', exact: true })
    .click();
  await expect(trash).toContainText('还没有归档内容');
  await page.getByRole('button', { name: '返回对话', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '展开侧栏', exact: true }),
  ).toBeFocused();
});

test('archives classify by type and project, search across pages and bound initial rows', async ({
  page,
}) => {
  await mock(page, 2, true);
  await page.goto('/');
  await page.evaluate(() =>
    localStorage.setItem(
      'mock-settings',
      JSON.stringify({
        sidebarItems: [
          {
            kind: 'project',
            path: 'C:/work/alpha',
            name: '核心项目',
            state: 'archived',
          },
          { kind: 'session', path: 'alpha.jsonl', state: 'archived' },
          { kind: 'session', path: 'beta.jsonl', state: 'deleted' },
          ...Array.from({ length: 70 }, (_, i) => ({
            kind: 'session',
            path: `unknown-${i}.jsonl`,
            name: `历史 ${i}`,
            state: 'archived',
          })),
        ],
      }),
    ),
  );
  await page.reload();
  await expect(
    page.getByRole('button', { name: '回收站', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: '已归档', exact: true }).click();
  const archive = page.getByRole('region', { name: '已归档', exact: true });
  await expect(archive.locator('[data-restore]')).toHaveCount(50);
  await archive.getByRole('button', { name: '显示更多（剩余 23 项）' }).click();
  await expect(archive.locator('[data-restore]')).toHaveCount(73);
  await archive
    .getByRole('combobox', { name: '所属项目' })
    .selectOption('c:/work/alpha');
  await expect(archive.locator('[data-restore]')).toHaveCount(2);
  await archive.getByRole('button', { name: '会话 72', exact: true }).click();
  await expect(archive.locator('[data-restore]')).toHaveCount(1);
  await archive.getByRole('textbox', { name: '搜索已归档' }).fill('核心项目');
  await expect(
    archive.getByRole('button', { name: '恢复会话 修复登录', exact: true }),
  ).toBeVisible();
  await archive.getByRole('button', { name: '清除筛选', exact: true }).click();
  await expect(archive.locator('[data-restore]')).toHaveCount(50);
  await archive.getByRole('textbox', { name: '搜索已归档' }).fill('历史 69');
  await expect(archive.locator('[data-restore]')).toHaveCount(1);
  await expect(archive).toContainText('未识别项目');
  await archive
    .getByRole('button', { name: '恢复会话 历史 69', exact: true })
    .click();
  await expect(archive).toContainText('没有匹配的内容');
  const saved = await page.evaluate(
    () => JSON.parse(localStorage.getItem('mock-settings')!).sidebarItems,
  );
  expect(saved.some((item: any) => item.state === 'deleted')).toBe(false);
});

test('context usage stays in the bottom-right footer and expands details in place', async ({
  page,
}) => {
  await mock(page);
  await page.goto('/');
  const meter = page.getByRole('button', { name: /上下文使用率/ });
  await expect(meter).toBeVisible();
  await expect(meter).toContainText('59.0% · 118k/200k');
  // 指标整体在输入区下方右侧，不与输入器抢占空间。
  const box = await meter.boundingBox();
  const footnote = await page.locator('.composer-footnote').boundingBox();
  expect(box!.y).toBeGreaterThan(footnote!.y - 1);
  expect(box!.x + box!.width).toBeGreaterThan(
    footnote!.x + footnote!.width - 80,
  );
  await meter.click();
  const panel = page.getByRole('group', { name: '上下文用量明细' });
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('50k');
  await expect(panel).toContainText('42.1%');
  await expect(panel).toContainText('$0.450');
  await page.screenshot({ path: 'test-results/context-usage.png' });
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(meter).toBeFocused();
  // 统计失败不应打断会话：指标保留，也不弹出全局错误。
  await page.evaluate(() => {
    (window as any).statsError = true;
  });
  await meter.click();
  await expect(panel).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('context usage explains unknown tokens right after compaction', async ({
  page,
}) => {
  await mock(page);
  await page.addInitScript(() => {
    (window as any).statsUnknown = true;
  });
  await page.goto('/');
  const meter = page.getByRole('button', { name: /上下文使用率/ });
  await expect(meter).toContainText('?% · ?/200k');
  await meter.click();
  await expect(
    page.getByRole('group', { name: '上下文用量明细' }),
  ).toContainText('压缩后需要等待下一次回答');
});
