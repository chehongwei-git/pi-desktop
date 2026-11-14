/** 真实主页面验证按需请求、迟到加载隔离及设置往返的草稿保留。 */
import { test, expect } from '@playwright/test';

test('loads management pages on demand without losing the conversation draft', async ({
  page,
}) => {
  await page.addInitScript(() => {
    (window as any).__TAURI_INTERNALS__ = {
      transformCallback: () => 1,
      unregisterCallback: () => {},
      async invoke(command: string) {
        if (command === 'get_settings')
          return { recentProjects: [], extraPath: [] };
        if (command === 'list_sessions' || command === 'list_activity')
          return [];
        if (command === 'load_workspace') return null;
        if (command === 'get_model_config')
          return { providers: [], version: '', issues: [] };
        if (command === 'connect_pi') throw new Error('测试不启动 Pi');
        return null;
      },
    };
  });
  const modules: string[] = [];
  page.on('request', (request) => {
    if (/\/(SettingsDialog|PluginsPage)\.svelte(?:\?|$)/.test(request.url()))
      modules.push(request.url());
  });
  let release!: () => void;
  const hold = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/SettingsDialog.svelte', async (route) => {
    await hold;
    await route.continue();
  });
  await page.goto('/');
  const input = page.getByRole('textbox', { name: '消息输入', exact: true });
  await input.fill('保留这个草稿');
  expect(modules).toEqual([]);
  await page.getByRole('button', { name: /^设置/ }).click();
  await expect(
    page.getByRole('status').filter({ hasText: '正在加载应用设置' }),
  ).toBeVisible();
  await page.screenshot({ path: 'test-results/lazy-page-loading.png' });
  await page.getByRole('button', { name: '返回', exact: true }).click();
  await expect(input).toHaveValue('保留这个草稿');
  // 返回恢复侧栏触发入口，而不是抢回输入框焦点。
  await expect(page.getByRole('button', { name: /^设置/ })).toBeFocused();
  const response = page.waitForResponse((response) =>
    response.url().endsWith('/SettingsDialog.svelte'),
  );
  release();
  await response;
  await expect(
    page.getByRole('region', { name: '应用设置', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: /^设置/ }).click();
  await expect(page.locator('.settings-page')).toBeVisible();
  expect(
    modules.filter((url) => url.endsWith('/SettingsDialog.svelte')),
  ).toHaveLength(1);
  expect(modules.some((url) => url.includes('PluginsPage.svelte'))).toBe(false);
  await page.screenshot({ path: 'test-results/lazy-page-settings.png' });
});
