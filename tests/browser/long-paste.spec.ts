import { test, expect, type Page } from '@playwright/test';

/** 真实输入器与对话布局，仅模拟宿主投影和受控正文引用，不调用在线模型。 */
async function paste(page: Page, text: string) {
  await page
    .getByRole('textbox', { name: '消息输入', exact: true })
    .evaluate((input, text) => {
      const data = new DataTransfer();
      data.setData('text/plain', text);
      input.dispatchEvent(
        new ClipboardEvent('paste', {
          clipboardData: data,
          bubbles: true,
          cancelable: true,
        }),
      );
    }, text);
}
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const host = window as any;
    host.sent = [];
    host.reads = [];
    let serial = 0;
    let channel: any;
    let index = 0;
    let sequence = 0;
    const callbacks = new Map();
    let events: any[] = [];
    const model = { provider: 'test', id: 'a', name: 'Test' };
    const messages = JSON.parse(
      localStorage.getItem('mock-text-messages') ?? '[]',
    );
    const bodies = JSON.parse(localStorage.getItem('mock-text-bodies') ?? '{}');
    host.__TAURI_INTERNALS__ = {
      transformCallback(callback: any) {
        callbacks.set(++serial, callback);
        return serial;
      },
      unregisterCallback(id: number) {
        callbacks.delete(id);
      },
      async invoke(command: string, args: any = {}) {
        if (command === 'get_settings')
          return {
            theme: 'light',
            zoom: 100,
            recentProjects: [],
            projectOrder: [],
            pinnedSessions: [],
            extraPath: [],
          };
        if (command === 'save_settings' || command === 'sync_process_pool')
          return;
        if (command === 'list_sessions') return [];
        if (command === 'connect_pi') {
          channel = args.channel;
          return {
            runtimeId: 'r',
            project: '/test',
            version: '1.4.0',
            verified: true,
            snapshot: { model, sessionFile: 's' },
          };
        }
        if (command === 'next_events') {
          const result = events;
          events = [];
          return { runtimeId: 'r', sequence: ++sequence, events: result };
        }
        if (command === 'read_content') {
          host.reads.push(args.id);
          if (host.failRead) {
            host.failRead = false;
            throw new Error('模拟正文读取失败');
          }
          const text = bodies[args.id];
          if (text === undefined) throw new Error('无效正文引用');
          const next = Math.min(text.length, args.offset + 4096);
          return {
            text: text.slice(args.offset, next),
            next,
            done: next === text.length,
          };
        }
        if (command === 'perform') {
          switch (args.action.type) {
            case 'models':
              return { models: [model] };
            case 'commands':
              return { commands: [] };
            case 'thinking_levels':
              return { levels: ['off'] };
            case 'state':
              return { model, sessionFile: 's' };
            case 'history':
              return { messages, before: 0, hasMore: false };
            case 'prompt': {
              host.sent.push(args.action);
              if (host.failSend) throw new Error('发送失败');
              const id = `user-${messages.length}`;
              const text = args.action.message;
              bodies[id] = text;
              const textParts = args.action.textParts?.map((part: any) => {
                const body = text.slice(part.start, part.end);
                const ref = `${id}-${part.id}`;
                bodies[ref] = body;
                const limit = part.kind === 'paste' ? 360 : 65536;
                return {
                  kind: part.kind,
                  id: part.id,
                  text: Array.from(body).slice(0, limit).join(''),
                  chars: Array.from(body).length,
                  contentRef: ref,
                  truncated: Array.from(body).length > limit,
                };
              });
              const message = {
                id,
                role: 'user',
                text: text.slice(0, 65536),
                truncated: text.length > 65536,
                contentRef: id,
                textParts,
                thinking: '',
                status: 'done',
                name: null,
              };
              messages.push(message);
              localStorage.setItem(
                'mock-text-messages',
                JSON.stringify(messages),
              );
              localStorage.setItem('mock-text-bodies', JSON.stringify(bodies));
              events.push({ type: 'message', message });
              callbacks.get(channel.id)?.({
                index: index++,
                message: { type: 'available', runtimeId: 'r' },
              });
              return {};
            }
            default:
              return {};
          }
        }
        if (command === 'get_submission') return null;
        throw new Error(command);
      },
    };
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: '添加图片' })).toBeEnabled();
});

test('click replaces the input card with its original text, then sends an inline expandable message', async ({
  page,
}) => {
  const input = page.getByRole('textbox', { name: '消息输入', exact: true });
  await input.fill('前后');
  await input.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(1, 1));
  const original = '需求\r\n' + '中文😀'.repeat(400);
  await paste(page, original);
  const card = page.locator('.paste-card');
  await expect(card).toHaveCount(1);
  await page.keyboard.type('补充');
  await card.click();
  await expect(card).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: '粘贴文本全文' })).toHaveCount(
    0,
  );
  await expect(input).toBeFocused();
  const copied = await input.evaluate((el) => {
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(el);
    selection.removeAllRanges();
    selection.addRange(range);
    const data = new DataTransfer();
    el.dispatchEvent(
      new ClipboardEvent('copy', {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }),
    );
    return data.getData('text/plain');
  });
  expect(copied).toBe('前' + original + '补充后');
  await input.press('ControlOrMeta+z');
  await expect(card).toHaveCount(1);
  await input.press('ControlOrMeta+Shift+z');
  await expect(card).toHaveCount(0);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).sent[0]?.message))
    .toBe('前' + original + '补充后');
  expect(
    await page.evaluate(() => (window as any).sent[0].textParts),
  ).toBeUndefined();
  const message = page.locator('.message.user');
  await expect(message.getByRole('button', { name: '展开更多' })).toBeVisible();
  await message.getByRole('button', { name: '展开更多' }).click();
  await expect(message.locator('.user-plain-text')).toHaveText(
    '前' + original + '补充后',
  );
  await expect(
    page.getByRole('complementary', { name: '粘贴文本全文' }),
  ).toHaveCount(0);
  await message
    .getByRole('button', { name: '收起', exact: true })
    .last()
    .click();
  await expect(message.getByRole('button', { name: '展开更多' })).toBeFocused();
  await page.reload();
  await expect(page.getByRole('button', { name: '展开更多' })).toBeVisible();
});

test('direct card send stays folded, opens on the right, retries reads and survives restart', async ({
  page,
}) => {
  const original = '第一份原文\n' + '甲😀'.repeat(40000);
  const second = '第二份原文\n' + '乙'.repeat(1200);
  const input = page.getByRole('textbox', { name: '消息输入', exact: true });
  await input.fill('请分析：');
  await input.press('End');
  await paste(page, original);
  await expect(page.locator('.paste-card')).toHaveCount(1);
  await page.keyboard.type('，对照');
  await paste(page, second);
  await expect(page.locator('.paste-card')).toHaveCount(2);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  const cards = page.locator('.message-text-card');
  await expect(cards).toHaveCount(2);
  await expect(page.locator('.paste-card')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).sent[0].message)).toBe(
    '请分析：' + original + '，对照' + second,
  );
  expect((await cards.first().textContent())!.length).toBeLessThan(400);
  await page.evaluate(() => {
    (window as any).failRead = true;
  });
  await cards.first().click();
  const panel = page.getByRole('complementary', { name: '粘贴文本全文' });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('alert')).toContainText('模拟正文读取失败');
  await panel.getByRole('button', { name: '重试读取全文' }).click();
  await expect(panel.getByRole('button', { name: '复制原文' })).toBeEnabled();
  await expect(panel.locator('.user-plain-text')).toHaveText(original);
  await cards.last().click();
  await expect(panel.locator('.user-plain-text')).toHaveText(second);
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          (window as any).copied = text;
        },
      },
    });
  });
  await panel.getByRole('button', { name: '复制原文' }).click();
  expect(await page.evaluate(() => (window as any).copied)).toBe(second);
  await panel.getByRole('button', { name: '关闭全文' }).press('Escape');
  await expect(cards.last()).toBeFocused();
  await page.getByRole('button', { name: '复制消息' }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).copied))
    .toBe('请分析：' + original + '，对照' + second);
  await page.reload();
  await expect(cards).toHaveCount(2);
  await expect(panel).toHaveCount(0);
  await cards.first().click();
  await expect(panel.locator('.user-plain-text')).toHaveText(original);
});

test('preserves failed drafts, two-step deletion and mixed restored text with retained cards', async ({
  page,
}) => {
  const input = page.getByRole('textbox', { name: '消息输入', exact: true });
  const text = '原文'.repeat(600);
  await input.focus();
  await paste(page, text);
  await page.keyboard.press('Backspace');
  await expect(page.locator('.paste-card')).toHaveCount(1);
  await page.keyboard.press('Backspace');
  await expect(page.locator('.paste-card')).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.locator('.paste-card')).toHaveCount(1);
  await expect
    .poll(() =>
      page.evaluate(() => localStorage.getItem('pi-desktop-workspace-v1')),
    )
    .toContain('"kind":"paste"');
  await page.reload();
  await expect(page.locator('.paste-card')).toHaveCount(1);
  await page.evaluate(() => {
    (window as any).failSend = true;
  });
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).sent.length))
    .toBe(1);
  await expect(page.locator('.paste-card')).toHaveCount(1);
  await page.locator('.paste-card').click();
  await expect(page.locator('.paste-card')).toHaveCount(0);
  await paste(page, '保留卡片'.repeat(300));
  await expect(page.locator('.paste-card')).toHaveCount(1);
  await page.evaluate(() => {
    (window as any).failSend = false;
  });
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.locator('.message-text-card')).toHaveCount(1);
  await expect(
    page.locator('.message.user').getByRole('button', { name: '展开更多' }),
  ).toBeVisible();
});

test('copies and cuts multiple cards losslessly and restores the selected range', async ({
  page,
}) => {
  const input = page.getByRole('textbox', { name: '消息输入', exact: true });
  const first = '第一段\r\n'.repeat(12);
  const second = '第二段😀'.repeat(300);
  await input.fill('开头');
  await input.press('End');
  await paste(page, first);
  await expect(page.locator('.paste-card')).toHaveCount(1);
  await page.keyboard.type('中间');
  await paste(page, second);
  await expect(page.locator('.paste-card')).toHaveCount(2);
  await page.keyboard.type('结尾');
  await input.press('ControlOrMeta+a');
  const copied = await input.evaluate((el) => {
    const data = new DataTransfer();
    el.dispatchEvent(
      new ClipboardEvent('cut', {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }),
    );
    return data.getData('text/plain');
  });
  expect(copied).toBe('开头' + first + '中间' + second + '结尾');
  await expect(page.locator('.paste-card')).toHaveCount(0);
  await input.press('ControlOrMeta+z');
  await expect(page.locator('.paste-card')).toHaveCount(2);
  await page.keyboard.type('替换');
  await expect(input).toHaveText('替换');
  await expect(page.locator('.paste-card')).toHaveCount(0);
});

test('card and text panel fit narrow layouts, both themes and 200 percent zoom', async ({
  page,
}) => {
  await page.setViewportSize({ width: 600, height: 900 });
  await page
    .getByRole('button', { name: '收起侧栏', exact: true })
    .last()
    .click();
  const input = page.getByRole('textbox', { name: '消息输入', exact: true });
  await input.focus();
  await paste(page, '长文本'.repeat(34000));
  await expect(page.locator('.paste-card')).toHaveCount(1);
  expect(
    (await page.locator('.paste-card').textContent())!.length,
  ).toBeLessThan(160);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  const card = page.locator('.message-text-card');
  await expect(card).toHaveCount(1);
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    await page.screenshot({ path: `test-results/sent-text-card-${theme}.png` });
    await card.click();
    const panel = page.getByRole('complementary', { name: '粘贴文本全文' });
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('button', { name: '复制原文' })).toBeEnabled();
    await page.evaluate(() => {
      document.documentElement.style.zoom = '2';
    });
    expect(await panel.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: `test-results/sent-text-panel-${theme}.png`,
    });
    await panel.getByRole('button', { name: '关闭全文' }).press('Escape');
    await expect(card).toBeFocused();
    await page.evaluate(() => {
      document.documentElement.style.zoom = '';
    });
  }
});
