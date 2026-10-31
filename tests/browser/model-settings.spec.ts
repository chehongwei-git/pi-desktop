import { test, expect } from '@playwright/test';

/** 只模拟宿主边界，验证设置保存、重新进入、映射和草稿保护的完整页面路径。 */
test('configures a discovered model and protects unsaved work', async ({
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
            p.credential = { action: 'keep', value: '', confirmReplace: false };
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
  await page.goto('/');
  await page.getByRole('button', { name: /^设置/ }).click();
  await page.getByRole('button', { name: '模型与服务商', exact: true }).click();
  await page.getByRole('button', { name: '添加端点', exact: true }).click();
  await page.getByLabel('端点标识').fill('my-proxy');
  await page.getByRole('button', { name: '创建端点', exact: true }).click();
  await page
    .getByRole('combobox', { name: 'API 协议', exact: true })
    .selectOption('openai-responses');
  await page.getByLabel('API 基础地址').fill('https://example.test/v1');
  await page.getByRole('button', { name: '获取远端模型' }).click();
  await page.getByRole('checkbox', { name: /Remote model/ }).check();
  await page.getByRole('button', { name: '添加所选模型到草稿' }).click();
  await page.locator('.model-editor > summary').click();
  await page.getByLabel('上下文长度（tokens）').fill('200000');
  await page.getByLabel('最大输出（tokens）').fill('32000');
  await page
    .getByRole('combobox', { name: '图片输入', exact: true })
    .selectOption('true');
  await page
    .getByRole('combobox', { name: '思考能力', exact: true })
    .selectOption('true');
  await page.getByText('思考等级映射', { exact: true }).click();
  await page.getByLabel('remote-model max 支持方式').selectOption('custom');
  await page.getByLabel('remote-model max 服务端值').fill('max');
  await page
    .getByRole('combobox', { name: '此模型的默认思考等级', exact: true })
    .selectOption('max');
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
});
