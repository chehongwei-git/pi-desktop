import { test, expect } from '@playwright/test';

/** 只模拟宿主边界，覆盖主题、窄窗口、映射与草稿保护的完整页面路径。 */
for (const variant of [
  { width: 1200, theme: 'light' },
  { width: 600, theme: 'dark' },
] as const) {
  test(`configures a discovered model and protects unsaved work ${variant.width} ${variant.theme}`, async ({
    page,
  }) => {
    await page.addInitScript(() => {
      let config = {
        revision: 'r1',
        directory: '/isolated/pi',
        providers: [],
        defaultProvider: null,
        defaultModel: null,
        defaultThinkingLevel: null,
      };
      (window as any).__TAURI_INTERNALS__ = {
        transformCallback: () => 1,
        unregisterCallback: () => {},
        async invoke(command: string, args: any = {}) {
          if (command === 'get_settings')
            return {
              schemaVersion: 1,
              theme: 'system',
              zoom: 100,
              piPath: '',
              runtimePath: '',
              sessionDir: '',
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
              project: '/isolated',
              snapshot: {},
              version: '1.4.0',
              verified: true,
            };
          if (command === 'next_events')
            return { runtimeId: 'r', sequence: 0, events: [] };
          if (command === 'get_model_config') return structuredClone(config);
          if (command === 'discover_models')
            return {
              models: [{ id: 'remote-model', name: 'Remote model' }],
              truncated: false,
            };
          if (command === 'save_model_config') {
            config = structuredClone(args.config);
            config.revision = 'r2';
            for (const p of config.providers as any[]) {
              p.credentialSource = '已保存 API Key';
              p.credential = {
                action: 'keep',
                value: '',
                confirmReplace: false,
              };
            }
            (window as any).savedModelConfig = structuredClone(config);
            return config;
          }
          if (command === 'perform') {
            if (args.action.type === 'models') return { models: [] };
            if (args.action.type === 'thinking_levels')
              return { levels: ['off'] };
            if (args.action.type === 'commands') return { commands: [] };
            if (args.action.type === 'history')
              return { messages: [], before: 0, hasMore: false };
            return {};
          }
          throw new Error(command);
        },
      };
    });
    await page.setViewportSize({ width: variant.width, height: 800 });
    await page.emulateMedia({ colorScheme: variant.theme });
    await page.goto('/');
    await page.getByRole('button', { name: /^设置/ }).click();
    await page
      .getByRole('button', { name: '模型与服务商', exact: true })
      .click();
    await page.getByRole('button', { name: '添加端点', exact: true }).click();
    await page.getByLabel('端点标识').fill('my-proxy');
    await page.getByRole('button', { name: '创建端点', exact: true }).click();
    const protocol = page.getByRole('combobox', {
      name: 'API 协议',
      exact: true,
    });
    await protocol.scrollIntoViewIfNeeded();
    await protocol.focus();
    const layout = page.locator('.settings-layout');
    const address = page.getByLabel('API 基础地址');
    const beforeAddress = await address.boundingBox();
    const beforeScroll = await layout.evaluate((node) => ({
      top: node.scrollTop,
      height: node.scrollHeight,
    }));
    await protocol.press('ArrowDown');
    const protocolList = page.getByRole('listbox', {
      name: 'API 协议',
      exact: true,
    });
    await expect(protocolList).toBeVisible();
    expect((await address.boundingBox())!.y).toBeCloseTo(beforeAddress!.y, 1);
    expect(
      await layout.evaluate((node) => ({
        top: node.scrollTop,
        height: node.scrollHeight,
      })),
    ).toEqual(beforeScroll);
    await protocol.press('ArrowDown');
    await protocol.press('Enter');
    await expect(protocol).toContainText('OpenAI Responses');
    await protocol.press('Enter');
    await protocol.press('Escape');
    await expect(protocol).toBeFocused();
    await protocol.click();
    await page.getByLabel('API 基础地址').click();
    await expect(
      page.getByRole('listbox', { name: 'API 协议', exact: true }),
    ).toHaveCount(0);
    await expect(protocol).toHaveAttribute('aria-expanded', 'false');
    await page.getByLabel('API 基础地址').fill('https://example.test/v1');
    await page.getByRole('button', { name: '获取远端模型' }).click();
    await page.getByRole('checkbox', { name: /Remote model/ }).check();
    await page.getByRole('button', { name: '添加所选模型到草稿' }).click();
    await page.locator('.model-editor > summary').click();
    await page.getByLabel('上下文长度（tokens）').fill('200000');
    await page.getByLabel('最大输出（tokens）').fill('32000');
    await page.getByRole('combobox', { name: '图片输入', exact: true }).click();
    await page.getByRole('option', { name: '文字与图片', exact: true }).click();
    await expect(
      page.getByRole('combobox', { name: '思考能力', exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole('combobox', { name: '此模型的默认思考等级', exact: true })
      .click();
    await expect(
      page.getByRole('option', { name: '超高 · xhigh', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('option', { name: '最高 · max', exact: true }),
    ).toBeVisible();
    await page.getByRole('option', { name: '高 · high', exact: true }).click();
    await expect(
      page.getByText('思考已开启，由最终生效的思考等级决定。'),
    ).toBeVisible();
    await page.locator('.mapping-summary').click();
    await page.locator('.thinking').scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `test-results/thinking-mapping-${variant.theme}-${variant.width}.png`,
    });
    await page
      .getByRole('combobox', { name: 'remote-model max 支持方式', exact: true })
      .click();
    await page.getByRole('option', { name: '自定义映射', exact: true }).click();
    await page.getByLabel('remote-model max 服务端值').fill('max');
    const thinking = page.getByRole('combobox', {
      name: '此模型的默认思考等级',
      exact: true,
    });
    await thinking.scrollIntoViewIfNeeded();
    // 将入口放到底部，验证列表向上展开且不挤动下面的状态说明。
    await thinking.evaluate((node) => {
      const layout = node.closest('.settings-layout')!;
      const bounds = layout.getBoundingClientRect();
      layout.scrollTop +=
        node.getBoundingClientRect().bottom - (bounds.bottom - 15);
    });
    await thinking.focus();
    const stateText = page.getByText('思考已开启，由最终生效的思考等级决定。');
    const stateBefore = await stateText.boundingBox();
    const scrollBeforeThinking = await layout.evaluate(
      (node) => node.scrollTop,
    );
    await thinking.press('Enter');
    const thinkingList = page.getByRole('listbox', {
      name: '此模型的默认思考等级',
      exact: true,
    });
    await expect(thinkingList).toBeVisible();
    expect((await stateText.boundingBox())!.y).toBeCloseTo(stateBefore!.y, 1);
    expect(
      (await thinkingList.boundingBox())!.y +
        (await thinkingList.boundingBox())!.height,
    ).toBeLessThan((await thinking.boundingBox())!.y);
    await thinking.press('End');
    expect(await layout.evaluate((node) => node.scrollTop)).toBe(
      scrollBeforeThinking,
    );
    const maximum = page.getByRole('option', {
      name: '最高 · max',
      exact: true,
    });
    await expect(maximum).toBeInViewport({ ratio: 1 });
    // 页面滚动时浮层跟随入口，入口完全离开可见区后自动关闭。
    await layout.evaluate((node) => {
      node.scrollTop -= 20;
    });
    await expect
      .poll(async () =>
        Math.abs(
          (await thinkingList.boundingBox())!.y +
            (await thinkingList.boundingBox())!.height +
            5 -
            (await thinking.boundingBox())!.y,
        ),
      )
      .toBeLessThan(2);
    await page.setViewportSize({ width: variant.width, height: 760 });
    await expect(thinkingList).toBeInViewport({ ratio: 1 });
    await page.screenshot({
      path: `test-results/model-select-${variant.theme}-${variant.width}.png`,
    });
    await maximum.click();
    // 放大后固定浮层仍与入口对齐，选项浏览不改变设置页滚动位置。
    await page.keyboard.press('Control++');
    await expect
      .poll(() => page.evaluate(() => document.documentElement.style.zoom))
      .toBe('1.1');
    await thinking.scrollIntoViewIfNeeded();
    await thinking.focus();
    const zoomScroll = await layout.evaluate((node) => node.scrollTop);
    await thinking.press('Enter');
    await thinking.press('End');
    await expect(thinkingList).toBeVisible();
    expect(
      Math.abs(
        (await thinkingList.boundingBox())!.x -
          (await thinking.boundingBox())!.x,
      ),
    ).toBeLessThan(2);
    expect(
      Math.abs(
        (await thinkingList.boundingBox())!.width -
          (await thinking.boundingBox())!.width,
      ),
    ).toBeLessThan(2);
    expect(await layout.evaluate((node) => node.scrollTop)).toBe(zoomScroll);
    await layout.evaluate((node) => {
      node.scrollTop = 0;
    });
    await expect(thinkingList).toHaveCount(0);
    await page.keyboard.press('Control+0');
    await page.getByRole('button', { name: '保存设置', exact: true }).click();
    await expect(page.getByText(/已保存并应用/)).toBeVisible();
    const saved = await page.evaluate(() => (window as any).savedModelConfig);
    expect(saved.providers[0].models[0].values).toMatchObject({
      contextWindow: 200000,
      maxTokens: 32000,
      input: ['text', 'image'],
      reasoning: true,
      thinkingLevelMap: { max: 'max' },
    });
    await page.getByLabel('API 基础地址').fill('https://changed.test/v1');
    await page.getByRole('button', { name: '返回对话' }).click();
    await expect(page.getByText('有未保存的更改，是否放弃？')).toBeVisible();
    await page.getByRole('button', { name: '继续编辑' }).click();
    await expect(page.getByLabel('API 基础地址')).toHaveValue(
      'https://changed.test/v1',
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
}
