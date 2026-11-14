/** 验证加载生命周期：等待可退出，失败显式重试，卸载后的迟到结果不再触碰 DOM。 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { afterEach, expect, it, vi } from 'vitest';
import LazyPage from './LazyPage.svelte';

const children = createRawSnippet<[unknown]>((value) => ({
  render: () => `<p>${value()}</p>`,
}));
afterEach(cleanup);

it('loads once and renders the resolved page', async () => {
  let resolve!: (value: { default: string }) => void;
  const load = vi.fn(
    () => new Promise<{ default: string }>((done) => (resolve = done)),
  );
  const view = render(LazyPage, {
    title: '应用设置',
    load,
    children,
    onclose: vi.fn(),
  });
  expect(view.getByRole('status')).toHaveTextContent('正在加载应用设置');
  expect(view.getByRole('button', { name: '返回' })).toHaveFocus();
  resolve({ default: '已加载的设置页面' });
  await waitFor(() => expect(view.getByText('已加载的设置页面')).toBeVisible());
  expect(view.queryByRole('status')).toBeNull();
  expect(load).toHaveBeenCalledOnce();
});

it('keeps failures inline and retries only on request', async () => {
  const load = vi
    .fn()
    .mockRejectedValueOnce(new Error('network'))
    .mockResolvedValueOnce({ default: '重试后的页面' });
  const view = render(LazyPage, {
    title: '插件管理',
    load,
    children,
    onclose: vi.fn(),
  });
  await waitFor(() =>
    expect(view.getByRole('alert')).toHaveTextContent('当前对话和草稿仍然保留'),
  );
  expect(load).toHaveBeenCalledOnce();
  await fireEvent.click(view.getByRole('button', { name: '重试加载' }));
  await waitFor(() => expect(view.getByText('重试后的页面')).toBeVisible());
  expect(load).toHaveBeenCalledTimes(2);
});

it('allows leaving during loading and ignores a result after unmount', async () => {
  let resolve!: (value: { default: string }) => void;
  const onclose = vi.fn();
  const load = () =>
    new Promise<{ default: string }>((done) => (resolve = done));
  const view = render(LazyPage, { title: '应用设置', load, children, onclose });
  await fireEvent.click(view.getByRole('button', { name: '返回' }));
  expect(onclose).toHaveBeenCalledOnce();
  await fireEvent.keyDown(window, { key: 'Escape' });
  expect(onclose).toHaveBeenCalledTimes(2);
  view.unmount();
  const input = document.createElement('input');
  document.body.append(input);
  input.focus();
  resolve({ default: '不应重新打开' });
  await Promise.resolve();
  expect(view.queryByText('不应重新打开')).toBeNull();
  expect(input).toHaveFocus();
  input.remove();
});
