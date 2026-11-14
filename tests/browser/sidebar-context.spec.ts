import { test, expect } from '@playwright/test';

/** 使用真实侧栏与异步 IPC，检查导航不会把最近列表挤走。 */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const sessions = Array.from({ length: 45 }, (_, i) => ({
      id: `s${i}`,
      path: `/sessions/s${i}.jsonl`,
      cwd: `/projects/p${i % 3}`,
      name: `会话 ${String(i).padStart(2, '0')}`,
      preview: '',
      timestamp: new Date(2025, 0, 45 - i).toISOString(),
      modified: 0,
      warning: null,
    }));
    const states = new Map();
    (window as any).__TAURI_INTERNALS__ = {
      transformCallback: () => 1,
      unregisterCallback: () => {},
      async invoke(command: string, args: any = {}) {
        if (command === 'get_settings')
          return {
            recentProjects: ['/projects/p0'],
            pinnedSessions: [sessions[1].path],
          };
        if (command === 'save_settings' || command === 'sync_process_pool')
          return;
        if (command === 'list_sessions') return sessions;
        if (command === 'list_activity') return [];
        if (command === 'connect_pi') {
          const session =
            sessions.find((s) => s.path === args.sessionPath) ?? sessions[0];
          const runtimeId = session.id;
          const snapshot = {
            sessionFile: session.path,
            cwd: session.cwd,
            isStreaming: false,
          };
          states.set(runtimeId, snapshot);
          // 延迟连接以覆盖点击后异步撑开项目的旧行为。
          await new Promise((resolve) => setTimeout(resolve, 80));
          return {
            runtimeId,
            project: session.cwd,
            snapshot,
            version: '1.4.0',
          };
        }
        if (command === 'next_events')
          return { runtimeId: args.runtimeId, sequence: 0, events: [] };
        if (command === 'perform') {
          switch (args.action.type) {
            case 'state':
              return states.get(args.runtimeId);
            case 'history':
              return { messages: [], before: 0, hasMore: false };
            case 'models':
              return { models: [] };
            case 'thinking_levels':
              return { levels: [] };
            case 'commands':
              return { commands: [] };
            case 'changes':
              return [];
            case 'session_stats':
              return {};
          }
        }
        throw new Error(`Unexpected command: ${command}`);
      },
    };
  });
  await page.goto('/');
  await expect(page.getByText('已连接', { exact: true })).toBeVisible();
});

test('最近跨项目冷加载和缓存切换保留滚动、分页与项目展开偏好', async ({
  page,
}) => {
  const recent = page.getByRole('region', { name: '最近', exact: true });
  const projects = page.locator('.project-current');
  // 用户显式展开一个项目，其余保持折叠；导航不得覆盖该布局。
  if ((await projects.first().getAttribute('aria-expanded')) === 'false')
    await projects.first().click();
  const expanded = await projects.evaluateAll((nodes) =>
    nodes.map((n) => n.getAttribute('aria-expanded')),
  );
  await recent.getByRole('button', { name: /显示更多会话/ }).click();
  await expect(recent.locator('.history-item')).toHaveCount(40);
  for (const id of ['s22', 's23', 's22']) {
    const row = recent.locator(`[data-sidebar-path="/sessions/${id}.jsonl"]`);
    await row.scrollIntoViewIfNeeded();
    const before = await row.boundingBox();
    const top = await page
      .locator('.history-list')
      .evaluate((node) => node.scrollTop);
    await row.click();
    await expect(row).toHaveAttribute('aria-current', 'page');
    await expect(page.getByText('已连接', { exact: true })).toBeVisible();
    expect(
      await projects.evaluateAll((nodes) =>
        nodes.map((n) => n.getAttribute('aria-expanded')),
      ),
    ).toEqual(expanded);
    expect(
      await page.locator('.history-list').evaluate((node) => node.scrollTop),
    ).toBeCloseTo(top, 0);
    expect((await row.boundingBox())!.y).toBeCloseTo(before!.y, 0);
    await expect(recent.locator('.history-item')).toHaveCount(40);
  }
  await page.screenshot({ path: 'test-results/sidebar-context-light.png' });
});

test('置顶与搜索键盘打开不修改普通布局或抢走入口焦点', async ({ page }) => {
  const projects = page.locator('.project-current');
  const expanded = await projects.evaluateAll((nodes) =>
    nodes.map((n) => n.getAttribute('aria-expanded')),
  );
  const pinned = page
    .getByRole('region', { name: '置顶', exact: true })
    .locator('.history-item');
  await pinned.focus();
  await pinned.press('Enter');
  await expect(page.getByText('已连接', { exact: true })).toBeVisible();
  await expect(pinned).toBeFocused();
  expect(
    await projects.evaluateAll((nodes) =>
      nodes.map((n) => n.getAttribute('aria-expanded')),
    ),
  ).toEqual(expanded);
  const search = page.getByRole('textbox', { name: '搜索历史会话' });
  await search.fill('会话 02');
  const row = page
    .getByRole('region', { name: '最近', exact: true })
    .locator('.history-item');
  await row.focus();
  await row.press('Enter');
  await expect(page.getByText('已连接', { exact: true })).toBeVisible();
  await expect(row).toBeFocused();
  await expect(search).toHaveValue('会话 02');
  await search.fill('');
  expect(
    await projects.evaluateAll((nodes) =>
      nodes.map((n) => n.getAttribute('aria-expanded')),
    ),
  ).toEqual(expanded);
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
  });
  await page.screenshot({ path: 'test-results/sidebar-context-dark.png' });
});

test('窄窗口收起并重新打开侧栏后仍保留最近入口与项目布局', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const recent = page.getByRole('region', { name: '最近', exact: true });
  const row = recent.locator('[data-sidebar-path="/sessions/s2.jsonl"]');
  await row.click();
  // 窄窗口按设计隐藏连接文案，仍检查真实连接状态而非要求隐藏文字可见。
  await expect(page.locator('.connection.connected')).toHaveText('已连接');
  await expect(page.locator('.app-shell')).toHaveClass(/sidebar-hidden/);
  await page.getByRole('button', { name: '展开侧栏', exact: true }).click();
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute('aria-current', 'page');
  for (const project of await page.locator('.project-current').all())
    await expect(project).toHaveAttribute('aria-expanded', 'false');
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
  });
  await page.screenshot({
    path: 'test-results/sidebar-context-dark-narrow.png',
  });
});
