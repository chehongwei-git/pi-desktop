import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import MessageView from './MessageView.svelte';
import type { Message } from '../types';
afterEach(cleanup);
function props(message: Partial<Message> = {}) {
  return {
    message: {
      id: 'user',
      role: 'user',
      text: '原文'.repeat(600),
      thinking: '',
      status: 'done',
      name: null,
      contentRef: null,
      ...message,
    } as Message,
    onfull: vi.fn(),
    onload: vi.fn().mockResolvedValue(undefined),
    onerror: vi.fn(),
    toolViews: {},
    ontoggletool: vi.fn(),
    read: vi.fn().mockResolvedValue({ text: '完整内容', next: 4, done: true }),
  };
}
it('only mounts a bounded user preview and preserves the original message for copying', async () => {
  const p = props();
  const view = render(MessageView, p);
  expect(
    view.container.querySelector('.text-preview')!.textContent!.length,
  ).toBeLessThanOrEqual(360);
  expect(view.getByRole('button', { name: '展开更多' })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  await fireEvent.click(view.getByRole('button', { name: '展开更多' }));
  expect(p.ontoggletool).toHaveBeenCalledWith('user', 'text');
  await view.rerender({ toolViews: { user: { text: true } } });
  await waitFor(() =>
    expect(view.container.querySelector('.user-plain-text')).toHaveTextContent(
      p.message.text,
    ),
  );
  expect(view.getAllByRole('button', { name: '收起' })).toHaveLength(2);
});
it('uses the right-panel callback for cards and does not hide surrounding instructions', async () => {
  const p = props({
    text: '看全文重点',
    textParts: [
      {
        kind: 'text',
        id: 'a',
        text: '看',
        chars: 1,
        contentRef: null,
        truncated: false,
      },
      {
        kind: 'paste',
        id: 'p',
        text: '全文',
        chars: 10000,
        contentRef: 'part',
        truncated: true,
      },
      {
        kind: 'text',
        id: 'b',
        text: '重点',
        chars: 2,
        contentRef: null,
        truncated: false,
      },
    ],
  });
  const ontext = vi.fn();
  const view = render(MessageView, { ...p, ontext });
  expect(view.getByText('重点', { exact: true })).toBeVisible();
  await fireEvent.click(view.getByRole('button', { name: /查看粘贴文本/ }));
  expect(ontext).toHaveBeenCalledWith(
    p.message,
    p.message.textParts![1],
    expect.any(HTMLButtonElement),
  );
  expect(p.read).not.toHaveBeenCalled();
  await view.rerender({ selectedPart: 'p' });
  expect(view.getByRole('button', { name: /查看粘贴文本/ })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
});
it('copies complete paged text and reports failures without copying a preview', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
  const p = props({ text: 'preview', truncated: true, contentRef: 'body' });
  const view = render(MessageView, p);
  await fireEvent.click(view.getByRole('button', { name: '复制消息' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith('完整内容'));
  p.read.mockRejectedValueOnce(new Error('读取失败'));
  await fireEvent.click(await view.findByRole('button', { name: '复制消息' }));
  await waitFor(() =>
    expect(p.onerror).toHaveBeenCalledWith(expect.stringContaining('读取失败')),
  );
  expect(writeText).toHaveBeenCalledTimes(1);
});
it('renders sent references as read-only cards while retaining raw message copying', async () => {
  const text = '检查\n\n文件引用：\n"/project/a.pdf"';
  const p = props({
    text,
    textParts: [
      {
        kind: 'text',
        id: 'text',
        text: '检查',
        chars: 2,
        contentRef: null,
        truncated: false,
      },
      {
        kind: 'files',
        id: 'files',
        text: '\n\n文件引用：\n"/project/a.pdf"',
        chars: 25,
        contentRef: null,
        truncated: false,
        files: [{ id: 'f', path: '/project/a.pdf', directory: false }],
      },
    ],
  });
  const view = render(MessageView, p);
  expect(
    view.getByRole('button', { name: '查看文件引用：a.pdf' }),
  ).toBeVisible();
  expect(view.queryByText('文件引用：')).toBeNull();
  await fireEvent.click(
    view.getByRole('button', { name: '查看文件引用：a.pdf' }),
  );
  expect(p.ontoggletool).toHaveBeenCalledWith('user', 'file:f');
  await view.rerender({ toolViews: { user: { 'file:f': true } } });
  expect(view.getByRole('region', { name: '文件引用详情' })).toHaveTextContent(
    '/project/a.pdf',
  );
  await fireEvent.click(view.getByRole('button', { name: '查看原文' }));
  await view.rerender({ toolViews: { user: { 'files:raw': true } } });
  expect(view.container.querySelector('.user-plain-text')?.textContent).toBe(
    text,
  );
});
it('keeps assistant Markdown outside user folding rules', () => {
  const view = render(
    MessageView,
    props({ role: 'assistant', text: '# 回答\n\n' + '正文'.repeat(600) }),
  );
  expect(view.getByRole('heading', { name: '回答' })).toBeVisible();
  expect(view.queryByRole('button', { name: '展开更多' })).toBeNull();
});
