/** 真实页面验证原生事件适配、附件布局与发送；仅替换宿主 IPC，不调用模型。 */
import { test, expect, type Page } from '@playwright/test';
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1sAAAAASUVORK5CYII=';
const files = [
  {
    id: 'reference',
    kind: 'path',
    path: '/project/设计资料/非常长的产品需求文档用于验证文件名省略和扩展名保留.pdf',
    name: '非常长的产品需求文档用于验证文件名省略和扩展名保留.pdf',
    directory: false,
  },
  {
    id: 'image',
    kind: 'image',
    image: {
      id: 'hash',
      name: '界面截图.png',
      mimeType: 'image/png',
      data: png,
    },
  },
  {
    id: 'svg',
    kind: 'path',
    path: '/project/assets/icon.svg',
    name: 'icon.svg',
    directory: false,
    notice: '此格式按路径引用',
  },
  {
    id: 'directory',
    kind: 'path',
    path: '/project/src',
    name: 'src',
    directory: true,
  },
];
async function nativeDrop(page: Page, event: string, inside = true) {
  await page.evaluate(
    ({ event, inside }) => {
      const rect = document.querySelector('.composer')!.getBoundingClientRect();
      const position = {
        x: (inside ? rect.left + 20 : 1) * window.devicePixelRatio,
        y: (inside ? rect.top + 20 : 1) * window.devicePixelRatio,
      };
      (window as any).emitNative(event, {
        dropId: 'drop-ticket',
        position,
        paths: [],
      });
    },
    { event, inside },
  );
}
test.beforeEach(async ({ page }) => {
  await page.addInitScript((files) => {
    const host = window as any;
    const callbacks = new Map<number, (event: any) => void>();
    const listeners = new Map<number, { event: string; handler: number }>();
    let serial = 0;
    host.isTauri = true;
    host.sent = [];
    host.fileReads = [];
    host.files = files;
    host.emitNative = (event: string, payload: any) => {
      for (const [id, listener] of listeners)
        if (listener.event === event)
          callbacks.get(listener.handler)?.({ id, event, payload });
    };
    host.hasFileListener = () =>
      [...listeners.values()].some(
        (item) => item.event === 'desktop-file-drop',
      );
    host.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener: (_event: string, id: number) => listeners.delete(id),
    };
    const model = {
      id: 'vision',
      provider: 'test',
      name: 'Test Vision',
      input: ['text', 'image'],
    };
    host.__TAURI_INTERNALS__ = {
      metadata: {
        currentWindow: { label: 'main' },
        currentWebview: { label: 'main' },
      },
      transformCallback(callback: (event: any) => void) {
        callbacks.set(++serial, callback);
        return serial;
      },
      unregisterCallback(id: number) {
        callbacks.delete(id);
      },
      async invoke(command: string, args: any = {}) {
        if (command === 'plugin:event|listen') {
          const id = ++serial;
          listeners.set(id, args);
          return id;
        }
        if (command === 'plugin:event|unlisten') {
          listeners.delete(args.eventId);
          return;
        }
        if (command === 'plugin:webview|set_webview_zoom') return;
        if (command === 'get_settings')
          return {
            theme: 'light',
            zoom: 100,
            recentProjects: [],
            pinnedSessions: [],
            projectOrder: [],
            extraPath: [],
          };
        if (['save_settings', 'sync_process_pool'].includes(command)) return;
        if (['list_sessions', 'list_activity'].includes(command)) return [];
        if (command === 'connect_pi')
          return {
            runtimeId: 'r',
            project: '/project',
            version: '1.5.0',
            verified: true,
            snapshot: { model, sessionFile: '/session' },
          };
        if (command === 'pick_files' || command === 'read_dropped_files') {
          host.fileReads.push({ command, ...args });
          return structuredClone(host.files);
        }
        if (command === 'next_events')
          return { runtimeId: 'r', sequence: 0, events: [] };
        if (command === 'perform') {
          if (args.action.type === 'models') return { models: [model] };
          if (args.action.type === 'thinking_levels')
            return { levels: ['off'] };
          if (args.action.type === 'commands') return { commands: [] };
          if (args.action.type === 'state')
            return { model, sessionFile: '/session' };
          if (args.action.type === 'history')
            return { messages: [], before: 0, hasMore: false };
          if (args.action.type === 'prompt') {
            host.sent.push(args.action);
            if (host.failSend) throw new Error('发送失败');
            return {};
          }
          return {};
        }
        throw new Error(command);
      },
    };
  }, files);
  await page.goto('/');
  await expect(page.getByRole('button', { name: '添加文件' })).toBeEnabled();
  await expect
    .poll(() => page.evaluate(() => (window as any).hasFileListener()))
    .toBe(true);
});

test('native drop respects input bounds, keeps hover geometry stable and sends mixed attachments', async ({
  page,
}) => {
  const input = page.getByRole('textbox', { name: '消息输入', exact: true });
  await input.fill('检查这些文件');
  const before = await input.boundingBox();
  await nativeDrop(page, 'desktop-file-drop', false);
  expect(await page.evaluate(() => (window as any).fileReads)).toEqual([]);
  await nativeDrop(page, 'tauri://drag-over');
  await expect(page.getByText('松开以添加文件')).toBeVisible();
  expect(await input.boundingBox()).toEqual(before);
  await nativeDrop(page, 'desktop-file-drop');
  await expect(page.locator('[data-attachment]')).toHaveCount(4);
  await expect(page.getByText('松开以添加文件')).not.toBeVisible();
  expect(
    await page
      .locator('[data-attachment]')
      .evaluateAll((nodes) =>
        nodes.map((node) => (node as HTMLElement).dataset.attachment),
      ),
  ).toEqual(files.map((file) => file.id));
  await expect(page.getByText('此格式按路径引用')).toBeVisible();
  const read = await page.evaluate(() => (window as any).fileReads[0]);
  expect(read.command).toBe('read_dropped_files');
  expect(read.dropId).toBe('drop-ticket');
  await page.screenshot({
    path: 'test-results/file-attachments-light.png',
    animations: 'disabled',
  });
  await page.getByRole('button', { name: /查看文件引用：非常长/ }).click();
  await expect(
    page.getByRole('region', { name: '文件引用详情' }),
  ).toContainText(files[0].path!);
  await page.getByRole('button', { name: '收起预览' }).press('Escape');
  await expect(
    page.getByRole('button', { name: /查看文件引用：非常长/ }),
  ).toBeFocused();
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.locator('[data-attachment]')).toHaveCount(0);
  const sent = await page.evaluate(() => (window as any).sent[0]);
  expect(sent.message).toBe(
    '检查这些文件\n\n文件引用：\n' +
      files
        .filter((file) => file.kind === 'path')
        .map((file) => JSON.stringify(file.path))
        .join('\n'),
  );
  expect(sent.images).toEqual([
    { type: 'image', data: png, mimeType: 'image/png' },
  ]);
});

test('file cards fit narrow dark layouts and scaling, preserve failed drafts and restore paths after reload', async ({
  page,
}) => {
  await page.getByRole('button', { name: '添加文件' }).click();
  await expect(page.locator('[data-attachment]')).toHaveCount(4);
  await page.setViewportSize({ width: 480, height: 1000 });
  const sidebar = page
    .getByRole('button', { name: '收起侧栏', exact: true })
    .last();
  if (await sidebar.isVisible()) await sidebar.click();
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
  });
  const first = page.getByRole('button', { name: /查看文件引用：非常长/ });
  await first.click();
  const details = page.getByRole('region', { name: '文件引用详情' });
  let box = (await details.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(480);
  await page.screenshot({
    path: 'test-results/file-attachments-dark-narrow.png',
    animations: 'disabled',
  });
  await page.getByRole('button', { name: '编辑路径' }).click();
  const pathInput = page.getByRole('textbox', { name: '完整路径' });
  await expect(pathInput).toBeFocused();
  const edited =
    process.platform === 'win32'
      ? 'C:\\project\\edited.pdf'
      : '/project/edited.pdf';
  await pathInput.fill(edited);
  await pathInput.press('Enter');
  await expect(details).toContainText(edited);
  await page.getByRole('button', { name: '收起预览' }).click();
  await page.setViewportSize({ width: 1200, height: 1200 });
  await page.evaluate(() => {
    document.documentElement.style.zoom = '2';
    document.documentElement.style.setProperty('--preview-zoom', '2');
  });
  await page.getByRole('button', { name: /查看文件引用：edited/ }).click();
  box = (await details.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(1200);
  await page.screenshot({
    path: 'test-results/file-attachments-dark-zoom.png',
    animations: 'disabled',
  });
  await page.getByRole('button', { name: '收起预览' }).click();
  await page.evaluate(() => {
    document.documentElement.style.zoom = '';
    document.documentElement.style.removeProperty('--preview-zoom');
    (window as any).failSend = true;
  });
  await page
    .getByRole('textbox', { name: '消息输入', exact: true })
    .fill('保留草稿');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.locator('[data-attachment]')).toHaveCount(4);
  await expect(
    page.getByRole('textbox', { name: '消息输入', exact: true }),
  ).toHaveValue('保留草稿');
  await expect
    .poll(() =>
      page.evaluate(() => localStorage.getItem('pi-desktop-workspace-v1')),
    )
    .toContain('edited.pdf');
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem('pi-desktop-workspace-v1') || '{}')
            .drafts?.[0]?.snapshot?.text,
      ),
    )
    .toBe('保留草稿');
  await page.reload();
  await expect(page.locator('[data-attachment]')).toHaveCount(3);
  await expect(
    page.getByRole('textbox', { name: '消息输入', exact: true }),
  ).toHaveValue('保留草稿');
  await expect(
    page.getByRole('button', { name: /查看文件引用：edited/ }),
  ).toBeVisible();
});

for (const zoom of [1, 2])
  test(`selected textarea text moves, undoes and cancels at ${zoom * 100}% scale`, async ({
    page,
  }) => {
    await page.evaluate((zoom) => {
      document.documentElement.style.zoom = String(zoom);
      document.documentElement.style.setProperty(
        '--preview-zoom',
        String(zoom),
      );
    }, zoom);
    const input = page.getByRole('textbox', { name: '消息输入', exact: true });
    await input.fill('MOVE stay');
    const points = await input.evaluate((node: HTMLTextAreaElement) => {
      node.setSelectionRange(0, 4);
      const rect = node.getBoundingClientRect();
      return {
        start: { x: rect.left + 20, y: rect.top + 14 },
        end: { x: rect.right - 8, y: rect.top + 14 },
      };
    });
    await page.mouse.move(points.start.x, points.start.y);
    await page.mouse.down();
    await page.mouse.move(points.end.x, points.end.y, { steps: 8 });
    await page.mouse.up();
    await expect(input).toHaveValue(' stayMOVE');
    expect(
      await input.evaluate((node: HTMLTextAreaElement) => [
        node.selectionStart,
        node.selectionEnd,
      ]),
    ).toEqual([5, 9]);
    await input.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
    await expect(input).toHaveValue('MOVE stay');
    await page.mouse.move(points.start.x, points.start.y);
    await page.mouse.down();
    await page.mouse.move(points.end.x, points.end.y, { steps: 8 });
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await expect(input).toHaveValue('MOVE stay');
    expect(await page.evaluate(() => (window as any).fileReads)).toEqual([]);
  });

test('dragging a selected paste card preserves its identity, full text and undo transaction', async ({
  page,
}) => {
  const input = page.getByRole('textbox', { name: '消息输入', exact: true });
  const text = Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n');
  await input.fill('prefix ');
  await input.evaluate((node, text) => {
    const data = new DataTransfer();
    data.setData('text/plain', text);
    node.dispatchEvent(
      new ClipboardEvent('paste', {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, text);
  const card = page.locator('.paste-card');
  await expect(card).toBeVisible();
  await input.pressSequentially(' tail');
  const id = await card.getAttribute('data-paste-id');
  const points = await input.evaluate((node) => {
    const card = node.querySelector('[data-paste-id]')!;
    const range = document.createRange();
    range.selectNode(card);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    const from = card.getBoundingClientRect();
    const to = node.getBoundingClientRect();
    return {
      start: { x: from.left + 20, y: from.top + from.height / 2 },
      end: { x: to.left + 1, y: from.top + from.height / 2 },
    };
  });
  await page.mouse.move(points.start.x, points.start.y);
  await page.mouse.down();
  await page.mouse.move(points.end.x, points.end.y, { steps: 8 });
  await page.mouse.up();
  await expect(card).toHaveAttribute('data-paste-id', id!);
  await expect
    .poll(() =>
      input.evaluate(
        (node) => (node.firstChild as HTMLElement).dataset?.pasteId,
      ),
    )
    .toBe(id);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem('pi-desktop-workspace-v1') || '{}')
            .drafts?.[0]?.snapshot?.text,
      ),
    )
    .toBe(text + 'prefix  tail');
  await input.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await expect
    .poll(() => input.evaluate((node) => node.firstChild?.textContent))
    .toBe('prefix ');
  await expect(card).toHaveAttribute('data-paste-id', id!);
});
