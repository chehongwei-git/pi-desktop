import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import MessageView from './MessageView.svelte';
import type { MessageEdit } from '../message-edit';
import type { Message } from '../types';
afterEach(cleanup);
const message: Message = {
  id: 'u',
  role: 'user',
  text: '原消息',
  thinking: '',
  status: 'done',
  contentRef: null,
  name: null,
};
function props() {
  return {
    message,
    toolViews: {},
    read: vi.fn(),
    onfull: vi.fn(),
    onload: vi.fn(),
    onerror: vi.fn(),
    ontoggletool: vi.fn(),
    onedit: vi.fn(),
  };
}
it('offers an icon-only edit action only for confirmed user messages', async () => {
  const p = props();
  const view = render(MessageView, p);
  const button = view.getByRole('button', { name: '编辑并重发' });
  expect(button.textContent?.trim()).toBe('');
  expect(button.querySelector('svg')).not.toBeNull();
  await fireEvent.click(button);
  expect(p.onedit).toHaveBeenCalledWith(message);
  await view.rerender({ message: { ...message, role: 'assistant' } });
  expect(view.queryByRole('button', { name: '编辑并重发' })).toBeNull();
  await view.rerender({
    message: { ...message, delivery: { mode: 'steer', state: 'queued' } },
  });
  expect(view.queryByRole('button', { name: '编辑并重发' })).toBeNull();
});
it('edits in place with only cancel/send, concise hint and run-state feedback', async () => {
  const edit: MessageEdit = {
    message,
    draft: { text: '原消息', parts: [], attachments: [] },
    loading: false,
    busy: false,
    error: '',
  };
  const onsend = vi.fn();
  const cancel = vi.fn();
  const view = render(MessageView, {
    ...props(),
    edit,
    onresend: onsend,
    oncancelEdit: cancel,
  });
  expect(view.getByRole('textbox', { name: '编辑消息内容' })).toHaveValue(
    '原消息',
  );
  expect(view.getByText('从此处重新回答，文件不回退。')).toBeVisible();
  expect(view.queryByText(/原对话保留/)).toBeNull();
  expect(view.queryByRole('button', { name: '复制消息' })).toBeNull();
  await fireEvent.keyDown(view.getByRole('textbox'), {
    key: 'Enter',
    ctrlKey: true,
    isComposing: true,
  });
  expect(onsend).not.toHaveBeenCalled();
  await fireEvent.click(view.getByRole('button', { name: /^发送$/ }));
  expect(onsend).toHaveBeenCalledTimes(1);
  await view.rerender({ editUnavailable: '请等待当前任务结束后发送。' });
  expect(view.getByRole('button', { name: /^发送$/ })).toBeDisabled();
  expect(view.getByRole('status')).toHaveTextContent('请等待当前任务结束');
  await fireEvent.click(view.getByRole('button', { name: /^取消$/ }));
  expect(cancel).toHaveBeenCalledTimes(1);
});
