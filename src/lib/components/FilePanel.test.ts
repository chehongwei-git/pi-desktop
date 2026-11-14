import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import FilePanel from './FilePanel.svelte';
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke, Channel: class {} }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
it('项目外就地授权，预览与系统打开均携带所属项目', async () => {
  invoke
    .mockResolvedValueOnce({
      path: '/outside/report.pdf',
      kind: 'approval',
      size: 0,
      canOpen: false,
    })
    .mockResolvedValueOnce({
      path: '/outside/report.pdf',
      kind: 'other',
      size: 42,
      canOpen: true,
    })
    .mockResolvedValueOnce(undefined);
  const close = vi.fn();
  const view = render(FilePanel, {
    props: {
      project: '/project',
      target: { path: '../outside/report.pdf' },
      onclose: close,
    },
  });
  await fireEvent.click(
    await view.findByRole('button', { name: '允许本次访问' }),
  );
  await fireEvent.click(
    await view.findByRole('button', { name: '使用系统默认应用打开' }),
  );
  expect(invoke).toHaveBeenLastCalledWith('open_message_file', {
    project: '/project',
    path: '../outside/report.pdf',
    approved: true,
  });
  await fireEvent.keyDown(view.getByRole('complementary'), { key: 'Escape' });
  expect(close).toHaveBeenCalledOnce();
});
it('切换文件后忽略迟到结果，读取失败保留路径并可重试', async () => {
  let resolve!: (value: unknown) => void;
  invoke
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    )
    .mockRejectedValueOnce({ message: '文件不存在' });
  const view = render(FilePanel, {
    props: {
      project: '/project',
      target: { path: 'old.txt' },
      onclose: vi.fn(),
    },
  });
  await view.rerender({ target: { path: 'new.txt' } });
  await view.findByRole('alert');
  resolve({
    path: '/project/old.txt',
    kind: 'text',
    text: '不能串文件',
    size: 20,
    canOpen: true,
  });
  await waitFor(() => expect(view.queryByText('不能串文件')).toBeNull());
  expect(view.getByRole('alert')).toHaveTextContent('文件不存在');
  invoke.mockResolvedValueOnce({
    path: '/project/new.txt',
    kind: 'text',
    text: '新内容',
    size: 9,
    canOpen: true,
  });
  await fireEvent.click(view.getByRole('button', { name: '重试读取' }));
  await view.findByText('新内容');
});
