import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import type { Desktop } from '../state/desktop.svelte';
import SidebarRename from './SidebarRename.svelte';

afterEach(cleanup);
it('keeps the edited name after a failed save and allows retry', async () => {
  const manageSidebar = vi
    .fn()
    .mockRejectedValueOnce(new Error('保存失败'))
    .mockResolvedValueOnce(undefined);
  const onclose = vi.fn();
  const view = render(SidebarRename, {
    desktop: { manageSidebar, sidebarSaving: false } as unknown as Desktop,
    kind: 'session',
    path: 'one',
    label: '原名称',
    onclose,
  });
  const input = view.getByRole('textbox', { name: '重命名会话' });
  await waitFor(() => expect(input).toHaveFocus());
  await fireEvent.input(input, { target: { value: '新名称' } });
  await fireEvent.submit(input.closest('form')!);
  await waitFor(() =>
    expect(view.getByRole('alert')).toHaveTextContent('保存失败'),
  );
  expect(input).toHaveValue('新名称');
  expect(onclose).not.toHaveBeenCalled();
  await fireEvent.submit(input.closest('form')!);
  await waitFor(() => expect(onclose).toHaveBeenCalledOnce());
  expect(manageSidebar).toHaveBeenLastCalledWith('session', 'one', {
    name: '新名称',
  });
});
it('cancels with Escape without saving and ignores IME confirmation', async () => {
  const manageSidebar = vi.fn();
  const onclose = vi.fn();
  const view = render(SidebarRename, {
    desktop: { manageSidebar, sidebarSaving: false } as unknown as Desktop,
    kind: 'project',
    path: 'one',
    label: '项目',
    onclose,
  });
  const input = view.getByRole('textbox', { name: '重命名项目' });
  expect(
    await fireEvent.keyDown(input, { key: 'Enter', isComposing: true }),
  ).toBe(false);
  await fireEvent.keyDown(input, { key: 'Escape' });
  expect(onclose).toHaveBeenCalledOnce();
  expect(manageSidebar).not.toHaveBeenCalled();
});
