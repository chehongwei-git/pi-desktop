/** 插件中心用替代领域端口测试，不读取用户配置或运行真实安装。 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import PluginsPage from './PluginsPage.svelte';
import type { PluginCatalog, NpmSearch } from '../plugins';
// jsdom 不实现布局观察；几何行为由真实浏览器测试覆盖。
beforeEach(() =>
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  ),
);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function fixture() {
  const catalog: PluginCatalog = {
    revision: 'r1',
    directory: 'isolated',
    warnings: [],
    items: [
      {
        id: 'docs',
        kind: 'mcp',
        name: 'Docs',
        description: 'Search documentation',
        source: 'mcp.json',
        scope: 'global',
        enabled: true,
        inherited: true,
        overridden: false,
        problem: null,
      },
    ],
  };
  const api = {
    search: vi
      .fn<(query: string) => Promise<NpmSearch>>()
      .mockResolvedValue({ exact: null, items: [], warnings: [] }),
    package: vi.fn(),
    catalog: vi.fn().mockResolvedValue(catalog),
    change: vi.fn().mockResolvedValue({ ...catalog, revision: 'r2' }),
    detail: vi.fn().mockResolvedValue('Safe details'),
    command: vi.fn().mockResolvedValue({ success: true, message: 'Checked' }),
  };
  const onclose = vi.fn();
  const view = render(PluginsPage, {
    projects: [{ path: 'project', name: 'Project' }],
    sessions: [],
    onclose,
    api,
  });
  return { view, api, onclose };
}
it('clears failed operation feedback after switching plugin categories', async () => {
  const { view, api } = fixture();
  await view.findByText('Docs');
  api.command.mockRejectedValueOnce(
    new Error(
      '使用 npm:包名、git:仓库、HTTPS 仓库或本地绝对路径（诊断 30752-1）',
    ),
  );
  await fireEvent.click(view.getByRole('button', { name: '检查连接' }));
  await fireEvent.click(view.getByRole('button', { name: '确认检查连接' }));
  await view.findByText(/使用 npm:包名/);
  expect(view.getByRole('status')).toHaveTextContent('操作未确认成功');
  await fireEvent.click(view.getByRole('button', { name: /^Skills/ }));
  expect(view.queryByText(/使用 npm:包名/)).not.toBeInTheDocument();
  expect(view.queryByRole('status')).not.toBeInTheDocument();
  await fireEvent.click(view.getByRole('button', { name: /^扩展/ }));
  expect(view.queryByRole('alert')).not.toBeInTheDocument();
});
it('does not let a late detail failure restore an error or steal focus after navigation', async () => {
  const { view, api } = fixture();
  await view.findByText('Docs');
  let fail!: (reason: Error) => void;
  api.detail.mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        fail = reject;
      }),
  );
  await fireEvent.click(view.getByRole('button', { name: /^Docs Search/ }));
  const skills = view.getByRole('button', { name: /^Skills/ });
  await fireEvent.click(skills);
  skills.focus();
  fail(new Error('旧详情读取失败'));
  await tick();
  await waitFor(() =>
    expect(view.getByText('还没有Skills')).toBeInTheDocument(),
  );
  expect(view.queryByText('旧详情读取失败')).not.toBeInTheDocument();
  expect(skills).toHaveFocus();
});
it('keeps errors and drafts when leaving is cancelled and clears them only after confirmed navigation', async () => {
  const { view, api } = fixture();
  await view.findByText('Docs');
  await fireEvent.click(view.getByRole('button', { name: '添加 MCP' }));
  await fireEvent.input(view.getByLabelText('服务器名称'), {
    target: { value: 'new' },
  });
  await fireEvent.input(view.getByLabelText('服务地址'), {
    target: { value: 'https://example.test/mcp' },
  });
  await fireEvent.click(view.getByRole('button', { name: '检查并预览' }));
  api.change.mockRejectedValueOnce(new Error('配置保存失败'));
  await fireEvent.click(view.getByRole('button', { name: '确认接入' }));
  await view.findByText('配置保存失败');
  await fireEvent.click(view.getByRole('button', { name: /^Skills/ }));
  await fireEvent.click(view.getByRole('button', { name: '继续留在此页' }));
  expect(view.getByText('配置保存失败')).toBeInTheDocument();
  expect(view.getByLabelText('服务器名称')).toHaveValue('new');
  await fireEvent.click(view.getByRole('button', { name: /^Skills/ }));
  await fireEvent.click(view.getByRole('button', { name: '放弃输入并继续' }));
  expect(view.queryByText('配置保存失败')).not.toBeInTheDocument();
  expect(view.getByText('还没有Skills')).toBeInTheDocument();
});
it('keeps online installs global when entered from a project catalog', async () => {
  const { view, api } = fixture();
  const rect = {
    x: 0,
    y: 20,
    top: 20,
    left: 0,
    right: 200,
    bottom: 60,
    width: 200,
    height: 40,
    toJSON() {},
  };
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([
    rect,
  ] as unknown as DOMRectList);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    function (this: HTMLElement) {
      return this.classList.contains('plugins-scroll')
        ? { ...rect, top: 0, bottom: 700, height: 700 }
        : rect;
    },
  );
  await view.findByText('Docs');
  await fireEvent.click(view.getByRole('combobox', { name: '插件配置范围' }));
  await fireEvent.click(view.getByRole('option', { name: /Project/ }));
  await waitFor(() => expect(api.catalog).toHaveBeenCalledWith('project'));
  const pkg = {
    name: 'pi-review',
    version: '1.0.0',
    description: 'review',
    publisher: 'example',
    piPackage: true,
    piManifest: false,
  };
  api.search.mockResolvedValue({ exact: pkg, items: [], warnings: [] });
  api.package.mockResolvedValue(pkg);
  await fireEvent.click(view.getByRole('button', { name: '在线安装' }));
  await fireEvent.input(view.getByLabelText('npm 包名或插件名称'), {
    target: { value: 'pi-review' },
  });
  await fireEvent.click(view.getByRole('button', { name: '查找' }));
  await fireEvent.click(
    await view.findByRole('button', { name: /pi-review 1.0.0/ }),
  );
  await fireEvent.click(await view.findByRole('button', { name: '全局安装' }));
  await waitFor(() =>
    expect(api.command).toHaveBeenCalledWith(
      null,
      'install',
      'npm:pi-review@1.0.0',
    ),
  );
});
it('reads only the catalog until the user explicitly diagnoses a connection', async () => {
  const { view, api } = fixture();
  await waitFor(() => expect(view.getByText('Docs')).toBeInTheDocument());
  expect(api.command).not.toHaveBeenCalled();
  await fireEvent.click(view.getByRole('button', { name: '检查连接' }));
  expect(api.command).not.toHaveBeenCalled();
  await fireEvent.click(view.getByRole('button', { name: '确认检查连接' }));
  await waitFor(() =>
    expect(api.command).toHaveBeenCalledWith(null, 'diagnose', ''),
  );
});
it('uses revisioned changes and does not confuse saved configuration with loaded state', async () => {
  const { view, api } = fixture();
  await waitFor(() => expect(view.getByText('Docs')).toBeInTheDocument());
  await fireEvent.click(view.getByRole('switch', { name: '停用 Docs' }));
  await waitFor(() =>
    expect(api.change).toHaveBeenCalledWith(null, {
      revision: 'r1',
      kind: 'mcp',
      id: 'docs',
      action: 'disable',
    }),
  );
  expect(view.getByText(/已保存，下次连接 Pi 时读取/)).toBeInTheDocument();
});
it('requires preview and keeps failed input while protecting navigation', async () => {
  const { view, api, onclose } = fixture();
  await waitFor(() => expect(view.getByText('Docs')).toBeInTheDocument());
  await fireEvent.click(view.getByRole('button', { name: '添加 MCP' }));
  await fireEvent.input(view.getByLabelText('服务器名称'), {
    target: { value: 'new' },
  });
  await fireEvent.input(view.getByLabelText('服务地址'), {
    target: { value: 'https://example.test/mcp' },
  });
  await fireEvent.click(view.getByRole('button', { name: '检查并预览' }));
  expect(api.change).not.toHaveBeenCalled();
  api.change.mockRejectedValueOnce(new Error('配置已被外部修改'));
  await fireEvent.click(view.getByRole('button', { name: '确认接入' }));
  await waitFor(() =>
    expect(view.getByRole('alert')).toHaveTextContent('配置已被外部修改'),
  );
  expect(view.getByLabelText('服务地址')).toHaveValue(
    'https://example.test/mcp',
  );
  await fireEvent.click(view.getByRole('button', { name: '← 返回对话' }));
  expect(onclose).not.toHaveBeenCalled();
  await fireEvent.click(view.getByRole('button', { name: '放弃输入并继续' }));
  expect(onclose).toHaveBeenCalledOnce();
});
