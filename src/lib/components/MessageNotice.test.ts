import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, expect, it, vi } from 'vitest';
import MessageNotice from './MessageNotice.svelte';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.body.replaceChildren();
});

it('keeps errors visible and expands long details inline without announcing controls', async () => {
  vi.useFakeTimers();
  const ondismiss = vi.fn();
  const view = render(MessageNotice, {
    message: '连接失败\n' + '诊断详情'.repeat(60),
    title: '操作未完成',
    tone: 'error',
    ondismiss,
  });
  expect(view.getByRole('alert')).toHaveTextContent('连接失败');
  expect(view.getByRole('alert').querySelector('button')).toBeNull();
  const expand = view.getByRole('button', { name: '展开详情' });
  await fireEvent.click(expand);
  expect(view.getByRole('button', { name: '收起详情' })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  await vi.advanceTimersByTimeAsync(30000);
  expect(ondismiss).not.toHaveBeenCalled();
  await view.rerender({ message: '新的错误' });
  expect(
    view.queryByRole('button', { name: '收起详情' }),
  ).not.toBeInTheDocument();
});

it('pauses automatic dismissal during hover or keyboard interaction and restarts for a new message', async () => {
  vi.useFakeTimers();
  const ondismiss = vi.fn();
  const view = render(MessageNotice, {
    message: '已复制',
    duration: 5000,
    ondismiss,
  });
  const card = view.getByRole('group');
  await fireEvent.pointerEnter(card);
  await vi.advanceTimersByTimeAsync(6000);
  expect(ondismiss).not.toHaveBeenCalled();
  await fireEvent.pointerLeave(card);
  await vi.advanceTimersByTimeAsync(4000);
  await view.rerender({ message: '名称已更新' });
  await vi.advanceTimersByTimeAsync(4000);
  expect(ondismiss).not.toHaveBeenCalled();
  await fireEvent.focusIn(view.getByRole('button'));
  await vi.advanceTimersByTimeAsync(6000);
  expect(ondismiss).not.toHaveBeenCalled();
  await fireEvent.focusOut(view.getByRole('button'), {
    relatedTarget: document.body,
  });
  await vi.advanceTimersByTimeAsync(5000);
  expect(ondismiss).toHaveBeenCalledOnce();
});

it.each(['success', 'info', 'error'] as const)(
  'automatically dismisses %s feedback when a duration is provided',
  async (tone) => {
    vi.useFakeTimers();
    const ondismiss = vi.fn();
    render(MessageNotice, {
      message: '操作反馈',
      tone,
      duration: 8000,
      ondismiss,
    });
    await vi.advanceTimersByTimeAsync(7999);
    expect(ondismiss).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(ondismiss).toHaveBeenCalledOnce();
  },
);

it('does not steal focus and returns it when dismissed from the keyboard', async () => {
  const input = document.createElement('textarea');
  document.body.append(input);
  input.focus();
  const ondismiss = vi.fn();
  const view = render(MessageNotice, { message: '已复制', ondismiss });
  await tick();
  expect(input).toHaveFocus();
  const close = view.getByRole('button', { name: '关闭提示' });
  close.focus();
  await fireEvent.click(close);
  expect(ondismiss).toHaveBeenCalledOnce();
  expect(input).toHaveFocus();
});
