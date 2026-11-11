/** 浏览器验证真实页面布局与草稿保护，宿主替身不触碰用户配置。 */
import { test, expect } from '@playwright/test';
for (const variant of [
  { width: 1200, theme: 'light' },
  { width: 600, theme: 'dark' },
] as const) {
  test(`plugin center ${variant.width} ${variant.theme}`, async ({ page }) => {
    await page.addInitScript(() => {
      const item = {
        id: 'docs',
        kind: 'mcp',
        name: 'Documentation',
        description: 'Search product documentation and reference material.',
        source: 'isolated/mcp.json',
        scope: 'global',
        enabled: true,
        inherited: true,
        overridden: false,
        problem: null,
      };
      const items = [
        item,
        {
          ...item,
          id: 'review',
          kind: 'skills',
          name: '代码审阅',
          description: '按项目约定审阅代码，关注正确性、可维护性和测试。',
          source: 'isolated/skills/review',
        },
        {
          ...item,
          id: 'local-extension',
          kind: 'extensions',
          name: '工作流工具',
          description: '为项目提供命令与工具。',
        },
        {
          ...item,
          id: 'builtin:codemode',
          kind: 'extensions',
          name: 'codemode',
          description: 'Pi 内置扩展',
        },
        {
          ...item,
          id: 'npm:@example/tools@1.0.0',
          kind: 'packages',
          name: 'npm:@example/tools@1.0.0',
          description: '扩展、Skills 与主题集合',
        },
      ];
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
          if (command === 'list_sessions' || command === 'list_activity')
            return [];
          if (command === 'save_settings') return;
          if (command === 'sync_process_pool' || command.startsWith('plugin:'))
            return;
          if (command === 'connect_pi')
            return {
              runtimeId: 'r',
              project: 'isolated',
              snapshot: {},
              version: '1.4.0',
              verified: true,
            };
          if (command === 'next_events')
            return { runtimeId: 'r', sequence: 0, events: [] };
          if (command === 'plugin_catalog')
            return {
              revision: 'r1',
              directory: 'isolated',
              items,
              warnings: [],
            };
          if (command === 'change_plugin') {
            item.enabled = args.change.action === 'enable';
            return {
              revision: 'r2',
              directory: 'isolated',
              items,
              warnings: [],
            };
          }
          if (command === 'plugin_detail')
            return args.kind === 'skills'
              ? '# 代码审阅指南\n\n## 检查要点\n\n- 验证业务规则\n- 保留测试覆盖\n\n' +
                  '说明与示例，长正文保持独立滚动。\n\n'.repeat(30)
              : '配置读取不会运行第三方代码。请确认来源可信后再在会话中加载。';
          if (command === 'perform') {
            if (args.action.type === 'models') return { models: [] };
            if (args.action.type === 'commands') return { commands: [] };
            if (args.action.type === 'history')
              return { messages: [], hasMore: false };
            return {};
          }
          throw new Error(command);
        },
      };
    });
    await page.setViewportSize({ width: variant.width, height: 800 });
    await page.emulateMedia({ colorScheme: variant.theme });
    await page.goto('/');
    await page.getByRole('button', { name: '插件', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: '插件', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText('Documentation', { exact: true }),
    ).toBeVisible();
    const panel = page.getByRole('region', { name: '插件管理' });
    expect(await panel.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: `test-results/plugins-${variant.theme}-${variant.width}.png`,
    });
    await page.getByRole('switch', { name: '停用 Documentation' }).click();
    await expect(
      page.getByRole('switch', { name: '启用 Documentation' }),
    ).toHaveAttribute('aria-checked', 'false');
    await page.getByRole('button', { name: '添加 MCP', exact: true }).click();
    await page.getByLabel('服务器名称').fill('new-docs');
    await page.getByLabel('服务地址').fill('https://example.test/mcp');
    await page.getByRole('button', { name: '← 返回对话', exact: true }).click();
    await expect(page.getByText('有未保存的插件输入')).toBeVisible();
    await page.getByRole('button', { name: '继续留在此页' }).click();
    await expect(page.getByLabel('服务器名称')).toHaveValue('new-docs');
    const shot = async (name: string) => {
      await page.screenshot({
        path: `test-results/plugins-${variant.theme}-${name}.png`,
      });
      expect(
        await panel.evaluate((el) => el.scrollWidth <= el.clientWidth),
      ).toBe(true);
    };
    const method = page.getByRole('combobox', {
      name: '接入方式',
      exact: true,
    });
    await method.click();
    await expect(
      page.getByRole('listbox', { name: '接入方式', exact: true }),
    ).toBeVisible();
    await shot('method-menu');
    await method.press('ArrowDown');
    await method.press('Enter');
    await expect(method).toContainText('本地进程');
    await page.getByLabel('可执行程序（不是 Shell 命令）').fill('node');
    await page
      .getByLabel('程序参数（每行一个）')
      .fill('server.mjs\n--read-only');
    await shot('stdio');
    await method.click();
    await page.getByRole('option', { name: /JSON 配置/ }).click();
    await page
      .getByLabel('服务器配置 JSON')
      .fill('{"url":"https://example.test/mcp"}');
    await shot('json');
    await method.click();
    await page.getByRole('option', { name: /远程 HTTP/ }).click();
    await expect(page.getByLabel('服务地址')).toHaveValue(
      'https://example.test/mcp',
    );
    await shot('http');
    await page.getByRole('button', { name: '检查并预览' }).click();
    await expect(page.locator('.preview-summary')).toContainText('远程 HTTP');
    await expect(page.getByLabel('服务地址')).toBeHidden();
    await shot('preview');
    await page.getByRole('button', { name: '返回编辑', exact: true }).click();
    await page.getByRole('button', { name: '← 返回MCP', exact: true }).click();
    await page.getByRole('button', { name: '放弃输入并继续' }).click();
    await page.getByRole('button', { name: /Documentation Search/ }).click();
    await expect(page.getByRole('region', { name: '插件详情' })).toBeVisible();
    await shot('mcp-detail');
    await page.getByRole('button', { name: '移除配置', exact: true }).click();
    await shot('remove-confirm');
    await page.getByRole('button', { name: '← 返回MCP', exact: true }).click();
    await page.getByRole('button', { name: /Skills/ }).click();
    await shot('skills-list');
    await page.getByRole('button', { name: /代码审阅 按项目/ }).click();
    await expect(
      page.getByRole('region', { name: 'Skill 使用说明' }),
    ).toContainText('检查要点');
    await shot('skill-detail');
    await page
      .getByRole('button', { name: '← 返回Skills', exact: true })
      .click();
    await page.getByRole('button', { name: '添加 Skill', exact: true }).click();
    await shot('local-skill');
    await page.getByRole('combobox', { name: '接入方式', exact: true }).click();
    await page.getByRole('option', { name: /Pi 安装包/ }).click();
    await page.getByLabel('安装包来源').fill('npm:@example/tools@1.0.0');
    await shot('package');
    await page
      .getByRole('button', { name: '← 返回Skills', exact: true })
      .click();
    await page.getByRole('button', { name: '放弃输入并继续' }).click();
    await page
      .getByRole('button', { name: /扩展/ })
      .filter({ has: page.locator('small') })
      .click();
    await expect(
      page.getByRole('heading', { name: '安装包', exact: false }),
    ).toBeVisible();
    await shot('extensions-list');
    await page.getByRole('button', { name: /工作流工具 为项目/ }).click();
    await shot('extension-detail');
    await page.getByRole('button', { name: '← 返回扩展', exact: true }).click();
    for (const zoom of [1.25, 1.5]) {
      await page.evaluate((z) => {
        document.documentElement.style.zoom = String(z);
      }, zoom);
      await page.getByRole('combobox', { name: '插件配置范围' }).click();
      const menu = page.getByRole('listbox', { name: '插件配置范围' });
      await expect(menu).toBeVisible();
      const rect = await menu.boundingBox();
      expect(rect!.x).toBeGreaterThanOrEqual(0);
      expect(rect!.x + rect!.width).toBeLessThanOrEqual(variant.width);
      await shot(`zoom-${zoom}`);
      await page
        .getByRole('combobox', { name: '插件配置范围' })
        .press('Escape');
    }
  });
}

for (const theme of ['light', 'dark'] as const) {
  test('plugin states and searchable selector ' + theme, async ({ page }) => {
    await page.setViewportSize({ width: 600, height: 800 });
    await page.route('**/plugins-fixture', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><html><head><meta charset="utf-8"></head><body><main></main><script type="module" src="/tests/browser/plugins-fixture.ts"></script></body></html>',
      }),
    );
    await page.goto('/plugins-fixture');
    await page.evaluate((t) => {
      document.documentElement.dataset.theme = t;
    }, theme);
    const scope = page.getByRole('combobox', { name: '插件配置范围' });
    await scope.click();
    await page.getByLabel('搜索配置范围').fill('工作项目 15');
    await expect(page.getByRole('option')).toHaveCount(1);
    await page.screenshot({
      path: 'test-results/plugins-' + theme + '-scope-search.png',
    });
    await page.getByLabel('搜索配置范围').press('Enter');
    await expect(scope).toContainText('工作项目 15');
    await scope.click();
    await page.getByLabel('搜索配置范围').fill('不存在的项目');
    await expect(page.getByText('没有匹配的选项')).toBeVisible();
    await page.getByLabel('搜索配置范围').press('Escape');
    await expect(scope).toBeFocused();
    await page.getByRole('button', { name: '空列表', exact: true }).click();
    await page.getByRole('button', { name: '重新读取插件' }).click();
    await expect(page.getByText('还没有MCP 服务器')).toBeVisible();
    await page.screenshot({
      path: 'test-results/plugins-' + theme + '-empty.png',
    });
    await page.getByRole('button', { name: '读取失败', exact: true }).click();
    await page.getByRole('button', { name: '重新读取插件' }).click();
    await expect(page.getByRole('alert')).toContainText('外部修改');
    await page.screenshot({
      path: 'test-results/plugins-' + theme + '-error.png',
    });
    await page.getByRole('button', { name: '恢复正常', exact: true }).click();
    await page.getByRole('button', { name: '重新读取插件' }).click();
    await page.getByRole('button', { name: '延迟读取', exact: true }).click();
    await page.getByRole('button', { name: '重新读取插件' }).click();
    await expect(scope).toBeDisabled();
    await page.screenshot({
      path: 'test-results/plugins-' + theme + '-loading.png',
    });
    await page.getByRole('button', { name: '恢复正常', exact: true }).click();
    await expect(scope).toBeEnabled();
  });
}
