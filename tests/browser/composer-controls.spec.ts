import { test, expect } from '@playwright/test';

/** 验证控件真正位于输入器内；仅模拟 IPC，覆盖键盘、失败草稿和窄窗口。 */
test('switches models and thinking beside the input and preserves drafts', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const host = window as any;
    const models = [
      { provider: 'test', id: 'a', name: 'Claude Opus' },
      { provider: 'test', id: 'b', name: 'GPT' },
    ];
    let model = models[0];
    let thinkingLevel = 'off';
    host.__TAURI_INTERNALS__ = {
      transformCallback: () => 1,
      unregisterCallback: () => {},
      async invoke(command: string, args: any = {}) {
        if (command === 'get_settings')
          return {
            schemaVersion: 1,
            theme: 'light',
            zoom: 100,
            recentProjects: [],
            projectOrder: [],
            pinnedSessions: [],
            extraPath: [],
          };
        if (command === 'save_settings') return;
        if (command === 'list_sessions') return [];
        if (command === 'connect_pi')
          return {
            runtimeId: 'r',
            project: '/test',
            version: '1.4.0',
            verified: true,
            snapshot: { model, thinkingLevel, sessionFile: 'test.jsonl' },
          };
        if (command === 'next_events')
          return { runtimeId: 'r', sequence: 0, events: [] };
        if (command === 'perform') {
          switch (args.action.type) {
            case 'models':
              return { models };
            case 'thinking_levels':
              return {
                levels: ['off', 'low', 'medium', 'high', 'xhigh', 'max'],
              };
            case 'commands':
              return { commands: [] };
            case 'history':
              return {
                messages: Array.from({ length: 8 }, (_, i) => ({
                  id: `tool-${i}`,
                  role: 'toolResult',
                  name: 'bash',
                  text: '工具输出\n'.repeat(40),
                  thinking: '',
                  status: 'done',
                  contentRef: null,
                  tool: {
                    name: 'bash',
                    callId: `call-${i}`,
                    command: `echo ${i}`,
                  },
                })),
                hasMore: false,
                before: 0,
              };
            case 'state':
              return { model, thinkingLevel, sessionFile: 'test.jsonl' };
            case 'set_model':
              if (host.failModel) throw new Error('模型切换失败');
              model = models.find((m) => m.id === args.action.model)!;
              thinkingLevel = 'off';
              return {};
            case 'set_thinking':
              thinkingLevel = args.action.level;
              return {};
            default:
              return {};
          }
        }
        throw new Error(command);
      },
    };
  });
  await page.goto('/');
  const composer = page.locator('.composer');
  const model = composer.getByRole('button', { name: '模型', exact: true });
  const thinking = composer.getByRole('button', {
    name: '思考级别',
    exact: true,
  });
  const input = page.getByRole('textbox', { name: '消息输入' });
  await expect(model).toBeEnabled();
  await expect(thinking).toHaveText(/思考\s*关闭/);
  await expect(page.locator('.topbar select')).toHaveCount(0);
  // 检查真实交叠位置的命中对象，不直接比较不同堆叠上下文的 z-index。
  async function expectMenusAboveTools() {
    for (const [trigger, panel] of [
      [model, composer.getByRole('region', { name: '选择模型' })],
      [thinking, composer.getByRole('menu', { name: '思考强度' })],
    ]) {
      await trigger.click();
      await expect(panel).toBeVisible();
      const hits = await panel.evaluate((menu) => {
        const bounds = menu.getBoundingClientRect();
        return [...document.querySelectorAll('.tool-heading')].flatMap(
          (heading) => {
            const rect = heading.getBoundingClientRect();
            const left = Math.max(bounds.left, rect.left);
            const right = Math.min(bounds.right, rect.right);
            const top = Math.max(bounds.top, rect.top);
            const bottom = Math.min(bounds.bottom, rect.bottom);
            if (left >= right || top >= bottom) return [];
            return [
              menu.contains(
                document.elementFromPoint(
                  (left + right) / 2,
                  (top + bottom) / 2,
                ),
              ),
            ];
          },
        );
      });
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.every(Boolean)).toBe(true);
      await page.keyboard.press('Escape');
      await expect(trigger).toBeFocused();
    }
  }
  await expect(page.locator('.tool-heading')).toHaveCount(8);
  await expectMenusAboveTools();
  await page.locator('.tool-heading').last().click();
  await expectMenusAboveTools();
  await page.locator('.tool-heading').last().click();
  await input.fill('检查草稿保留');
  await input.press('Tab');
  await expect(model).toBeFocused();
  await model.click();
  await composer.getByRole('textbox', { name: '搜索模型' }).fill('GPT');
  await composer.getByRole('textbox', { name: '搜索模型' }).press('Enter');
  await expect(model).toBeEnabled();
  await thinking.focus();
  await thinking.press('ArrowDown');
  await expect(
    composer.getByRole('menuitemradio', { checked: true }),
  ).toBeFocused();
  await expect(
    composer.getByRole('menuitemradio', { name: /极高 xhigh/ }),
  ).toBeVisible();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await expect(thinking).toBeEnabled();
  await expect(thinking).toHaveText(/思考\s*最高/);
  await expect(thinking).toBeFocused();
  await expect(input).toHaveValue('检查草稿保留');
  await model.click();
  await composer
    .getByRole('button', { name: 'Claude Opus a', exact: true })
    .click();
  await expect(model).toBeEnabled();
  await expect(thinking).toHaveText(/思考\s*最高/);
  await page.evaluate(() => {
    (window as any).failModel = true;
  });
  await model.click();
  await composer.getByRole('button', { name: 'GPT b', exact: true }).click();
  await expect(composer.getByRole('alert')).toHaveText('模型切换失败');
  await expect(model).toHaveAttribute('title', 'test/a');
  await expect(input).toHaveValue('检查草稿保留');
  await page.screenshot({
    path: 'test-results/composer-controls-light.png',
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole('button', { name: '收起侧栏', exact: true })
    .last()
    .click();
  await expect(model).toBeVisible();
  await expect(thinking).toBeVisible();
  await expectMenusAboveTools();
  const bounds = await composer.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  await model.click();
  const modelPanel = composer.getByRole('region', { name: '选择模型' });
  await expect(modelPanel).toBeVisible();
  const modelBounds = await modelPanel.boundingBox();
  expect(modelBounds!.x).toBeGreaterThanOrEqual(0);
  expect(modelBounds!.x + modelBounds!.width).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: 'test-results/model-picker-narrow.png',
    animations: 'disabled',
  });
  await page.keyboard.press('Escape');
  await thinking.click();
  const menu = composer.getByRole('menu', { name: '思考强度' });
  await expect(menu).toBeVisible();
  const menuBounds = await menu.boundingBox();
  expect(menuBounds!.x).toBeGreaterThanOrEqual(0);
  expect(menuBounds!.x + menuBounds!.width).toBeLessThanOrEqual(390);
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
  });
  await page.screenshot({
    path: 'test-results/composer-controls-dark-narrow.png',
    // 主题切换后完成颜色过渡，避免截图混合明暗两套表面颜色。
    animations: 'disabled',
  });
});
