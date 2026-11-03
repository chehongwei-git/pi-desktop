/** 真实界面验证缓存阅读与连接恢复并行；IPC 只模拟进程生命周期，不调用外部模型。 */
import { test, expect } from '@playwright/test';
test.use({ reducedMotion: 'reduce' });
// 十三个会话的顺序导航包含真实渲染和轮询回收，预留冷启动编译时间。
test.setTimeout(60000);
test('cached conversation stays readable and editable during reconnect without losing its anchor', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const host = window as any;
    host.isTauri = true;
    let serial = 0;
    const callbacks = new Map<number, any>();
    const runtimes = new Map<string, any>();
    const opened = new Set<string>();
    host.cacheLiveCount = () => runtimes.size;
    host.holdReconnect = false;
    const settings = {
      schemaVersion: 1,
      piPath: '',
      runtimePath: '',
      extraPath: [],
      sessionDir: '',
      recentProjects: ['/cache'],
      projectOrder: [],
      pinnedSessions: [],
      theme: 'light',
      zoom: 100,
      maxConcurrentTasks: 4,
    };
    const catalog = Array.from({ length: 13 }, (_, i) => ({
      path: `/cache/${i + 1}.jsonl`,
      cwd: '/cache',
      name: `缓存会话 ${i + 1} 号`,
      preview: '',
      timestamp: '',
      modified: i,
      id: String(i + 1),
      warning: null,
    }));
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
        if (command === 'plugin:event|listen') return 1;
        if (command === 'get_settings') return settings;
        if (command === 'save_settings') {
          Object.assign(settings, args.settings);
          return;
        }
        if (command === 'list_sessions') return catalog;
        if (command === 'list_activity') return [];
        if (command === 'connect_pi') {
          const path = args.sessionPath ?? '/cache/1.jsonl';
          if (opened.has(path) && host.holdReconnect)
            await new Promise<void>((resolve) => {
              host.resumeReconnect = resolve;
            });
          opened.add(path);
          const runtimeId = `runtime-${++serial}`;
          const snapshot = {
            sessionFile: path,
            cwd: '/cache',
            model: { provider: 'mock', id: 'm', name: 'Mock' },
            thinkingLevel: 'off',
          };
          runtimes.set(runtimeId, snapshot);
          return {
            runtimeId,
            project: '/cache',
            snapshot,
            version: '1.4.0',
            verified: true,
          };
        }
        if (command === 'disconnect_pi') {
          runtimes.delete(args.runtimeId);
          return;
        }
        if (command === 'next_events')
          return { runtimeId: args.runtimeId, sequence: 0, events: [] };
        if (command === 'perform') {
          const state = runtimes.get(args.runtimeId);
          if (!state) throw new Error('runtime already closed');
          const action = args.action;
          if (action.type === 'state') return state;
          if (action.type === 'models') return { models: [state.model] };
          if (action.type === 'thinking_levels') return { levels: ['off'] };
          if (action.type === 'commands') return { commands: [] };
          if (action.type === 'history')
            return {
              messages: Array.from({ length: 40 }, (_, i) => ({
                id: `entry-${i}`,
                role: 'assistant',
                text: `${state.sessionFile} · 第 ${i} 条\n\n${'可阅读的缓存正文。'.repeat(30)}`,
                thinking: '',
                status: 'done',
                contentRef: null,
                name: null,
              })),
              before: 0,
              hasMore: false,
            };
          return {};
        }
        return null;
      },
    };
  });
  await page.goto('/');
  const transcript = page.locator('.transcript:visible');
  await expect(transcript).toContainText('/cache/1.jsonl');
  await transcript.evaluate((node) => {
    node.scrollTop = 1500;
    node.dispatchEvent(new Event('scroll'));
  });
  const before = await transcript.evaluate((node) => node.scrollTop);
  await transcript.locator('[data-message-id="entry-0"]').evaluate((node) => {
    node.setAttribute('data-cache-marker', 'original');
  });
  await page.locator('.composer textarea').fill('切换前草稿');
  const open = async (index: number) => {
    const search = page.getByRole('textbox', { name: '搜索历史会话' });
    await search.fill(`缓存会话 ${index} 号`);
    await page
      .locator('.history-item')
      .filter({ hasText: `缓存会话 ${index} 号` })
      .first()
      .click();
    await search.fill('');
  };
  await open(2);
  await expect(transcript).toContainText('/cache/2.jsonl');
  await expect
    .poll(() => page.evaluate(() => (window as any).cacheLiveCount()))
    .toBe(1);
  await page.evaluate(() => {
    (window as any).holdReconnect = true;
  });
  await open(1);
  await expect(page.getByText('正在恢复连接', { exact: true })).toBeVisible();
  await expect(transcript).toContainText('/cache/1.jsonl');
  await expect(page.locator('.session-loading')).toHaveCount(0);
  await expect(page.locator('.composer textarea')).toHaveValue('切换前草稿');
  await page.locator('.composer textarea').fill('恢复期间的新草稿');
  await expect
    .poll(() => transcript.evaluate((node) => node.scrollTop))
    .toBeCloseTo(before, 0);
  // 用户在恢复期间继续阅读，提交历史时必须保持最新位置。
  await transcript.evaluate((node) => {
    node.scrollTop += 300;
    node.dispatchEvent(new Event('scroll'));
  });
  const during = await transcript.evaluate((node) => node.scrollTop);
  await page.evaluate(() => {
    const host = window as any;
    host.holdReconnect = false;
    host.resumeReconnect();
  });
  await expect(page.locator('.connection')).toHaveText('已连接');
  await expect(
    transcript.locator('[data-message-id="entry-0"]'),
  ).toHaveAttribute('data-cache-marker', 'original');
  await expect(page.locator('.composer textarea')).toHaveValue(
    '恢复期间的新草稿',
  );
  await expect
    .poll(() => transcript.evaluate((node) => node.scrollTop))
    .toBeCloseTo(during, 0);
  for (let index = 3; index <= 13; index++) {
    await open(index);
    await expect(transcript).toContainText(`/cache/${index}.jsonl`);
  }
  await expect
    .poll(() => page.evaluate(() => (window as any).cacheLiveCount()))
    .toBe(1);
  await expect(page.locator('.session-transcript')).toHaveCount(6);
  await open(1);
  await expect(transcript).toContainText('/cache/1.jsonl');
  await expect(page.locator('.composer textarea')).toHaveValue(
    '恢复期间的新草稿',
  );
});
