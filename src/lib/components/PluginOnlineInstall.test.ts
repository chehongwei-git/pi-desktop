/** 在线目录与安装均使用替身，验证副作用边界和失败恢复，不依赖公网。 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import PluginOnlineInstall from './PluginOnlineInstall.svelte';
import { npmIdentity, type NpmPackage, type PluginCatalog } from '../plugins';
afterEach(cleanup);
const pkg: NpmPackage = {
  name: '@example/review',
  version: '1.2.3',
  description: '审阅工具',
  publisher: 'example',
  piPackage: true,
  piManifest: false,
};
function fixture(recognized = true, alreadyInstalled = false) {
  const item = { ...pkg, piPackage: recognized };
  const catalog: PluginCatalog = {
    revision: 'r',
    directory: 'isolated',
    items: [],
    warnings: [],
  };
  const api = {
    search: vi.fn().mockResolvedValue({ exact: item, items: [], warnings: [] }),
    package: vi.fn().mockResolvedValue(item),
    catalog: vi
      .fn()
      .mockResolvedValue(alreadyInstalled ? installed(catalog) : catalog),
    command: vi.fn().mockResolvedValue({ success: true, message: 'done' }),
    change: vi.fn(),
    detail: vi.fn(),
  };
  const onbusy = vi.fn(),
    ondirty = vi.fn(),
    oninstalled = vi.fn(),
    onview = vi.fn();
  const view = render(PluginOnlineInstall, {
    api,
    onbusy,
    ondirty,
    oninstalled,
    onview,
  });
  async function choose() {
    await fireEvent.input(view.getByLabelText('npm 包名或插件名称'), {
      target: { value: 'review' },
    });
    await fireEvent.click(view.getByRole('button', { name: '查找' }));
    await fireEvent.click(
      await view.findByRole('button', { name: /@example\/review 1.2.3/ }),
    );
    await view.findByRole('region', { name: '安装包详情' });
  }
  return { view, api, choose, catalog, onbusy, oninstalled, onview, ondirty };
}
function installed(catalog: PluginCatalog): PluginCatalog {
  return {
    ...catalog,
    items: [
      {
        id: 'npm:@example/review@1.2.3',
        kind: 'packages',
        name: pkg.name,
        description: '',
        source: 'npm:@example/review@1.2.3',
        scope: 'global',
        enabled: true,
        inherited: false,
        overridden: false,
        problem: null,
      },
    ],
  };
}
it('normalizes npm identity without losing the organization', () => {
  expect(npmIdentity('npm:@example/review@1.2.3')).toBe('@example/review');
  expect(npmIdentity('npm:@example/review')).toBe('@example/review');
  expect(npmIdentity('npm:review@next')).toBe('review');
  expect(npmIdentity('git:review')).toBeNull();
});
it('searches by name but installs only a selected exact version globally', async () => {
  const f = fixture();
  await f.choose();
  expect(f.api.command).not.toHaveBeenCalled();
  expect(f.api.package).toHaveBeenCalledWith(pkg.name, '1.2.3');
  f.api.catalog.mockResolvedValue(installed(f.catalog));
  await fireEvent.click(f.view.getByRole('button', { name: '全局安装' }));
  await waitFor(() => expect(f.oninstalled).toHaveBeenCalledOnce());
  expect(f.api.command).toHaveBeenCalledExactlyOnceWith(
    null,
    'install',
    'npm:@example/review@1.2.3',
  );
  expect(f.onbusy.mock.calls).toEqual([[true], [false]]);
  await fireEvent.click(f.view.getByRole('button', { name: '查看已安装包' }));
  expect(f.onview).toHaveBeenCalledOnce();
});
it('prevents duplicate submissions while an installation is in flight', async () => {
  const f = fixture();
  await f.choose();
  let finish!: (value: { success: boolean; message: string }) => void;
  f.api.command.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const button = f.view.getByRole('button', { name: '全局安装' });
  await fireEvent.click(button);
  await fireEvent.click(button);
  expect(f.api.command).toHaveBeenCalledTimes(1);
  expect(f.onbusy).toHaveBeenLastCalledWith(true);
  f.api.catalog.mockResolvedValue(installed(f.catalog));
  finish({ success: true, message: 'done' });
  await waitFor(() => expect(f.oninstalled).toHaveBeenCalledOnce());
});
it('requires an explicit compatibility acknowledgement for an unmarked exact package', async () => {
  const f = fixture(false);
  await f.choose();
  expect(f.view.getByRole('button', { name: '全局安装' })).toBeDisabled();
  await fireEvent.click(
    f.view.getByRole('checkbox', { name: '已确认该包适用于 Pi' }),
  );
  expect(f.view.getByRole('button', { name: '全局安装' })).toBeEnabled();
});
it('checks configuration after a successful command without repeating an uncertain installation', async () => {
  const f = fixture();
  await f.choose();
  f.api.catalog.mockRejectedValueOnce(new Error('读取失败'));
  await fireEvent.click(f.view.getByRole('button', { name: '全局安装' }));
  await f.view.findByText(/无法核对全局安装配置/);
  expect(f.oninstalled).not.toHaveBeenCalled();
  await waitFor(() =>
    expect(f.view.getByRole('button', { name: '全局安装' })).toBeDisabled(),
  );
  f.api.catalog.mockResolvedValue(installed(f.catalog));
  await fireEvent.click(
    f.view.getByRole('button', { name: '重新读取全局配置' }),
  );
  await waitFor(() => expect(f.oninstalled).toHaveBeenCalledOnce());
  expect(f.api.command).toHaveBeenCalledTimes(1);
});
it('preserves failed input and blocks automatic resubmission after partial failure', async () => {
  const f = fixture();
  await f.choose();
  f.api.command.mockRejectedValueOnce(new Error('超时'));
  await fireEvent.click(f.view.getByRole('button', { name: '全局安装' }));
  await f.view.findByText(/可能已发生部分变更/);
  expect(f.view.getByLabelText('npm 包名或插件名称')).toHaveValue('review');
  expect(f.view.getByRole('button', { name: '全局安装' })).toBeDisabled();
  expect(f.oninstalled).not.toHaveBeenCalled();
});
it('allows an explicit new choice after a failed install is verified absent without replaying it', async () => {
  const f = fixture();
  await f.choose();
  f.api.command.mockRejectedValueOnce(new Error('安装失败'));
  await fireEvent.click(f.view.getByRole('button', { name: '全局安装' }));
  await f.view.findByText(/可能已发生部分变更/);
  await fireEvent.click(
    await f.view.findByRole('button', { name: '重新读取全局配置' }),
  );
  await fireEvent.click(
    await f.view.findByRole('button', { name: '重新选择安装包' }),
  );
  expect(f.api.command).toHaveBeenCalledTimes(1);
  expect(f.view.getByLabelText('npm 包名或插件名称')).toHaveValue('review');
  expect(f.view.getByRole('button', { name: '查找' })).toBeEnabled();
});
it('does not reinstall an existing global package', async () => {
  const f = fixture(true, true);
  await f.choose();
  await waitFor(() =>
    expect(f.view.getByText(/已全局安装：/)).toBeInTheDocument(),
  );
  expect(f.api.command).not.toHaveBeenCalled();
});
it('discards stale searches and stale package detail responses', async () => {
  const f = fixture();
  let finish!: (value: unknown) => void;
  f.api.search.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await fireEvent.input(f.view.getByLabelText('npm 包名或插件名称'), {
    target: { value: 'old' },
  });
  await fireEvent.click(f.view.getByRole('button', { name: '查找' }));
  await fireEvent.input(f.view.getByLabelText('npm 包名或插件名称'), {
    target: { value: 'new' },
  });
  await fireEvent.click(f.view.getByRole('button', { name: '重新查找' }));
  await f.view.findByRole('button', { name: /@example\/review 1.2.3/ });
  finish({ exact: { ...pkg, name: 'stale' }, items: [], warnings: [] });
  await waitFor(() =>
    expect(
      f.view.queryByRole('button', { name: /stale/ }),
    ).not.toBeInTheDocument(),
  );
  let detail!: (value: unknown) => void;
  f.api.package.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        detail = resolve;
      }),
  );
  await fireEvent.click(
    f.view.getByRole('button', { name: /@example\/review 1.2.3/ }),
  );
  await fireEvent.click(f.view.getByRole('button', { name: '查找' }));
  detail({ ...pkg, name: 'stale' });
  await waitFor(() =>
    expect(
      f.view.queryByRole('region', { name: '安装包详情' }),
    ).not.toBeInTheDocument(),
  );
});
it('shows partial search warnings and an empty result without inventing a package', async () => {
  const f = fixture();
  f.api.search.mockResolvedValue({
    exact: null,
    items: [],
    warnings: ['搜索暂不可用'],
  });
  await fireEvent.input(f.view.getByLabelText('npm 包名或插件名称'), {
    target: { value: 'missing' },
  });
  await fireEvent.click(f.view.getByRole('button', { name: '查找' }));
  await f.view.findByText('搜索暂不可用');
  expect(f.view.getByText('没有找到匹配的 Pi 插件')).toBeInTheDocument();
  expect(f.api.command).not.toHaveBeenCalled();
});
