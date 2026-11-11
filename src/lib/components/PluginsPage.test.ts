/** 插件中心用替代领域端口测试，不读取用户配置或运行真实安装。 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import PluginsPage from './PluginsPage.svelte';
import type { PluginCatalog } from '../plugins';
afterEach(cleanup);
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
