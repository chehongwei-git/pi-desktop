import { test, expect } from '@playwright/test';

test('returns from a new-chat draft to existing sessions', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    let sessionFile = 'original.jsonl';
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
      transformCallback: () => 1,
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
        if (command === 'next_events')
          return { runtimeId: 'runtime', sequence: 0, events: [] };
        if (command === 'perform') {
          switch (args.action.type) {
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
  await input.fill('Existing draft');
  await page.getByRole('button', { name: /^新对话/ }).click();
  await expect(page.locator('.welcome')).toBeVisible();
  await input.fill('New draft');
  await recent
    .getByRole('button', { name: 'original project', exact: true })
    .click();
  await expect(page.locator('.welcome')).toHaveCount(0);
  await expect(page.locator('.session-title')).toHaveText('original');
  await expect(input).toHaveValue('Existing draft');
  await page.getByRole('button', { name: /^新对话/ }).click();
  await expect(input).toHaveValue('New draft');
  await recent
    .getByRole('button', { name: 'other project', exact: true })
    .click();
  await expect(page.locator('.session-title')).toHaveText('other');
  await expect(
    page.getByText('History: other.jsonl', { exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
