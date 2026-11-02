/** 多项目并行浏览器验收，使用独立运行时模拟完整 IPC 契约。 */
import { test, expect } from '@playwright/test';
test.use({ reducedMotion: 'reduce' });
test('two projects keep independent sessions, queues, drafts and background interaction', async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => {
    const host = window as any;
    host.isTauri = true;
    let serial = 0;
    const callbacks = new Map<number, any>();
    const runtimes = new Map<string, any>();
    const tasks: any[] = [];
    const launches = new Map<string, () => void>();
    host.spawnCount = 0;
    const catalog = ['a', 'b'].flatMap((project) =>
      [1, 2].map((n) => ({
        path: `/${project}/${n}.jsonl`,
        cwd: `/${project}`,
        name: `${project.toUpperCase()}${n}`,
        preview: '',
        timestamp: '',
        modified: n,
        id: `${project}${n}`,
        warning: null,
      })),
    );
    const settings = {
      schemaVersion: 1,
      piPath: '',
      runtimePath: '',
      extraPath: [],
      sessionDir: '',
      recentProjects: ['/a'],
      projectOrder: [],
      pinnedSessions: [],
      theme: 'light',
      zoom: 100,
      maxConcurrentTasks: 4,
    };
    function notify(runtime: any, event: any) {
      callbacks.get(runtime.channel.id)?.({
        message: event,
        index: runtime.index++,
      });
    }
    function wake(runtime: any, events: any[]) {
      runtime.pending.push(...events);
      notify(runtime, { type: 'available', runtimeId: runtime.id });
    }
    function startNext() {
      if (
        tasks.filter((t) => t.state === 'running').length >=
        settings.maxConcurrentTasks
      )
        return;
      const next = tasks.find((t) => t.state === 'queued');
      if (next) {
        next.state = 'running';
        launches.get(next.taskId)?.();
      }
    }
    host.__TAURI_INTERNALS__ = {
      metadata: {
        currentWindow: { label: 'main' },
        currentWebview: { label: 'main' },
      },
      transformCallback(callback: any) {
        const id = ++serial;
        callbacks.set(id, callback);
        return id;
      },
      unregisterCallback(id: number) {
        callbacks.delete(id);
      },
      async invoke(command: string, args: any = {}) {
        if (command === 'plugin:event|listen') {
          if (args.event === 'desktop-close-requested')
            host.requestClose = () =>
              callbacks.get(args.handler)?.({
                event: args.event,
                id: 1,
                payload: null,
              });
          return 1;
        }
        if (command === 'pause_tasks') {
          host.paused = args.paused;
          return;
        }
        if (command === 'exit_app') {
          host.exitCalls = (host.exitCalls ?? 0) + 1;
          return;
        }
        if (command === 'get_settings') return settings;
        if (command === 'save_settings') {
          Object.assign(settings, args.settings);
          return;
        }
        if (command === 'list_sessions') return catalog;
        if (command === 'list_activity') return tasks.map((t) => ({ ...t }));
        if (command === 'cancel_queued_task') {
          tasks.find((t) => t.taskId === args.taskId).state = 'cancelled';
          return;
        }
        if (command === 'submit_new_task') {
          args = { ...args, ...args.request };
          const id = `reserved-${++serial}`;
          const task = {
            taskId: `task-${tasks.length}`,
            runtimeId: id,
            state: 'queued',
            position: 1,
          };
          tasks.push(task);
          launches.set(task.taskId, () => {
            host.spawnCount++;
            const state = {
              sessionFile: `${args.project}/new-${serial}.jsonl`,
              cwd: args.project,
              sessionName: 'queued new',
              model: { provider: 'mock', id: 'm', name: 'Mock' },
              thinkingLevel: 'off',
              isStreaming: true,
            };
            const r = {
              id,
              state,
              channel: args.channel,
              index: 0,
              pending: [],
              sequence: 0,
              messages: [],
            };
            runtimes.set(id, r);
            notify(r, {
              type: 'initialized',
              runtimeId: id,
              snapshot: { ...state },
              project: args.project,
            });
            wake(r, [
              { type: 'run', state: 'running' },
              {
                type: 'message',
                message: {
                  id: id + '-u',
                  role: 'user',
                  text: args.action.message,
                  thinking: '',
                  status: 'done',
                  contentRef: null,
                  name: null,
                },
              },
            ]);
          });
          // 首个 IPC 响应先返回，模拟原生调度器的异步启动。
          setTimeout(startNext, 0);
          return { desktopTask: task.taskId, runtimeId: id };
        }
        if (command === 'connect_pi') {
          host.spawnCount++;
          const id = `runtime-${++serial}`;
          const path =
            args.sessionPath ?? `/${args.project.slice(1)}/new-${serial}.jsonl`;
          const state = {
            sessionFile: path,
            cwd: args.project,
            sessionName: catalog.find((s) => s.path === path)?.name ?? 'new',
            model: { provider: 'mock', id: 'm', name: 'Mock' },
            thinkingLevel: 'off',
            isStreaming: false,
          };
          runtimes.set(id, {
            id,
            state,
            channel: args.channel,
            index: 0,
            pending: [],
            sequence: 0,
            messages: [
              {
                id: `${id}-u`,
                role: 'user',
                text: `history ${state.sessionName}`,
                thinking: '',
                status: 'done',
                contentRef: null,
                name: null,
              },
            ],
          });
          return {
            runtimeId: id,
            project: args.project,
            snapshot: { ...state },
            version: '1.4.0',
            verified: true,
          };
        }
        if (command === 'next_events') {
          const r = runtimes.get(args.runtimeId);
          const events = r.pending.splice(0);
          return { runtimeId: r.id, sequence: ++r.sequence, events };
        }
        if (command === 'perform') {
          const r = runtimes.get(args.runtimeId),
            a = args.action;
          if (a.type === 'state') return { ...r.state };
          if (a.type === 'history')
            return { messages: r.messages, before: 0, hasMore: false };
          if (a.type === 'models') return { models: [r.state.model] };
          if (a.type === 'commands') return { commands: [] };
          if (a.type === 'thinking_levels') return { levels: ['off'] };
          if (a.type === 'prompt') {
            const task = {
              taskId: `task-${tasks.length}`,
              runtimeId: r.id,
              state: 'running',
              position: 0,
            };
            tasks.push(task);
            r.state.isStreaming = true;
            wake(r, [
              { type: 'run', state: 'running' },
              {
                type: 'message',
                message: {
                  id: `${r.id}-send`,
                  role: 'user',
                  text: a.message,
                  thinking: '',
                  status: 'done',
                  contentRef: null,
                  name: null,
                },
              },
            ]);
            return { desktopTask: task.taskId };
          }
          if (a.type === 'stop') {
            r.state.isStreaming = false;
            tasks.find((t) => t.runtimeId === r.id).state = 'stopped';
            wake(r, [{ type: 'run', state: 'idle' }]);
            startNext();
            return {};
          }
          return {};
        }
        if (command === 'disconnect_pi') {
          runtimes.delete(args.runtimeId);
          return;
        }
        if (command.startsWith('plugin:')) return 1;
        return {};
      },
    };
    host.finishSession = (name: string, failed = false) => {
      const runtime = [...runtimes.values()].find(
        (item) => item.state.sessionName === name,
      );
      runtime.state.isStreaming = false;
      const task = tasks.find((item) => item.runtimeId === runtime.id);
      task.state = failed ? 'failed' : 'completed';
      if (failed) task.error = '模拟执行失败';
      wake(runtime, [{ type: 'run', state: 'idle' }]);
      startNext();
    };
    host.backgroundRequest = (name: string) => {
      const r = [...runtimes.values()].find(
        (r) => r.state.sessionName === name,
      );
      wake(r, [
        {
          type: 'extension',
          request: {
            id: 'shared-id',
            type: 'extension_ui_request',
            method: 'confirm',
            title: '请确认 A1 的操作',
            message: '后台确认',
          },
        },
      ]);
    };
  });
  await page.goto('/');
  await expect(
    page.locator('.history-item').filter({ hasText: 'A1' }).first(),
  ).toBeVisible();
  for (const name of ['A1', 'A2', 'B1', 'B2']) {
    // 通过搜索确保项目展开与最近列表采用同一个会话导航入口。
    const search = page.getByRole('textbox', { name: '搜索历史会话' });
    await search.fill(name);
    await page
      .locator('.history-item')
      .filter({ hasText: name })
      .first()
      .click();
    await expect(page.locator('.transcript:visible')).toContainText(
      `history ${name}`,
    );
    await page.locator('.composer textarea').fill(`work ${name}`);
    await page.locator('.composer textarea').press('Enter');
    await search.fill('');
  }
  await expect(page.locator('.activity-panel')).toHaveCount(0);
  await expect
    .poll(() =>
      page.locator('.session-status-icon[data-state=running]').count(),
    )
    .toBeGreaterThanOrEqual(4);
  await page.evaluate(() => (window as any).backgroundRequest('A1'));
  await expect(
    page.locator('.history-item').filter({ hasText: 'A1' }).first(),
  ).toHaveAccessibleName(/待你处理/);
  await expect(page.locator('.transcript:visible')).toContainText('work B2');
  const row = page.locator('.history-item').filter({ hasText: 'A1' }).first();
  await row.click();
  await expect(page.getByText('请确认 A1 的操作')).toBeVisible();
  await expect(page.locator('.transcript:visible')).toContainText('work A1');
  await page
    .getByRole('button', { name: '新对话', exact: false })
    .first()
    .click();
  await page.locator('.composer textarea').fill('fifth queued prompt');
  const countBefore = await page.evaluate(() => (window as any).spawnCount);
  await page.locator('.composer textarea').press('Enter');
  await expect(page.getByText('排队中，第', { exact: false })).toBeVisible();
  expect(await page.evaluate(() => (window as any).spawnCount)).toBe(
    countBefore,
  );
  const queued = page
    .locator('.history-item')
    .filter({ hasText: 'fifth queued prompt' })
    .first();
  await expect(queued).toHaveAccessibleName(/排队中/);
  const queuedEntry = await queued.evaluate((button) =>
    button.closest('[data-entry]')!.getAttribute('data-entry'),
  );
  await page.locator('.history-item').filter({ hasText: 'B2' }).first().click();
  await expect(page.locator('.transcript:visible')).toContainText('work B2');
  await page.getByRole('button', { name: '停止任务', exact: true }).click();
  await page.locator(`[data-entry="${queuedEntry}"] .history-item`).click();
  await expect(page.locator('.transcript:visible')).toContainText(
    'fifth queued prompt',
  );
  expect(await page.evaluate(() => (window as any).spawnCount)).toBe(
    countBefore + 1,
  );
  await page.evaluate(() => {
    (window as any).finishSession('A2');
    (window as any).finishSession('B1', true);
  });
  const completed = page
    .locator('.history-item')
    .filter({ hasText: 'A2' })
    .first();
  const failed = page
    .locator('.history-item')
    .filter({ hasText: 'B1' })
    .first();
  await expect(completed).toHaveAccessibleName(/已完成.*有新回复/);
  await expect(completed.locator('[data-state=completed]')).toBeVisible();
  await expect(failed.locator('[data-state=failed]')).toBeVisible();
  await expect(page.locator('.transcript:visible')).toContainText(
    'fifth queued prompt',
  );
  await completed.click();
  await expect(completed).toHaveAccessibleName(/已完成/);
  await expect(completed).not.toHaveAccessibleName(/有新回复/);
  await expect(completed.locator('[data-state=completed]')).toBeVisible();
  await page.locator(`[data-entry="${queuedEntry}"] .history-item`).click();
  await expect(page.locator('.session-status-icon .orbit').first()).toHaveCSS(
    'animation-name',
    'none',
  );
  await expect(
    page.getByText('设为项目新会话的默认模型与强度', { exact: true }),
  ).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath('multi-session-light.png'),
  });
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  await page.screenshot({
    path: testInfo.outputPath('multi-session-dark.png'),
  });
  await page.setViewportSize({ width: 600, height: 800 });
  await page.screenshot({
    path: testInfo.outputPath('multi-session-narrow.png'),
  });
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.evaluate(() => (window as any).requestClose());
  const exit = page.getByRole('region', { name: '退出应用确认' });
  await expect(exit).toBeVisible();
  await expect(
    exit.getByRole('button', { name: '停止任务并退出', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(exit).not.toBeVisible();
  await page.evaluate(() => (window as any).requestClose());
  await exit
    .getByRole('button', { name: '停止任务并退出', exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => (window as any).exitCalls))
    .toBe(1);
  expect(
    await page.evaluate(() => localStorage.getItem('pi-desktop-workspace-v1')),
  ).toContain('fifth queued prompt');
});
