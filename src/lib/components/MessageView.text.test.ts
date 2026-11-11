import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import MessageView from './MessageView.svelte';
import type { Message } from '../types';
import { restoreMessageDraft } from '../message-edit';
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
it('folds skill instructions without hiding the request and preserves copy/edit originals', async () => {
  const wrapper =
    '<skill name="docx" location="C:\\skills\\SKILL.md">\n说明\n</skill>';
  const request = '\n\n请整理文档';
  const p = props({
    text: wrapper + request,
    textParts: [
      {
        kind: 'skill',
        id: 'skill',
        text: '',
        chars: wrapper.length,
        contentRef: 'raw',
        truncated: true,
        skill: {
          name: 'docx',
          location: 'C:\\skills\\SKILL.md',
          text: '',
          contentRef: 'instructions',
          truncated: true,
        },
      },
      {
        kind: 'text',
        id: 'request',
        text: request,
        chars: request.length,
        contentRef: null,
        truncated: false,
      },
    ],
  });
  p.read.mockImplementation(async (id: string) => ({
    text: id === 'raw' ? wrapper : '说明',
    next: 100,
    done: true,
  }));
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
  const view = render(MessageView, p);
  expect(view.getByText('请整理文档')).toBeVisible();
  expect(view.queryByRole('region', { name: '技能说明' })).toBeNull();
  expect(p.read).not.toHaveBeenCalled();
  await fireEvent.click(view.getByRole('button', { name: /查看说明/ }));
  expect(p.ontoggletool).toHaveBeenCalledWith('user', 'skill:skill');
  await view.rerender({ toolViews: { user: { 'skill:skill': true } } });
  expect(await view.findByText('说明', { exact: true })).toBeVisible();
  const skillBody = view
    .getByRole('region', { name: '技能说明' })
    .querySelector<HTMLElement>('.skill-body')!;
  skillBody.focus();
  await fireEvent.keyDown(skillBody, { key: 'Escape' });
  await view.rerender({ toolViews: {} });
  await waitFor(() =>
    expect(view.getByRole('button', { name: /查看说明/ })).toHaveFocus(),
  );
  await fireEvent.click(view.getByRole('button', { name: '复制消息' }));
  await waitFor(() =>
    expect(writeText).toHaveBeenCalledWith(wrapper + request),
  );
  const draft = await restoreMessageDraft(p.message, p.read);
  expect(draft.text).toBe(wrapper + request);
});
it('retries failed skill reads in place', async () => {
  const p = props({
    text: 'raw',
    textParts: [
      {
        kind: 'skill',
        id: 'skill',
        text: '',
        chars: 100,
        contentRef: 'raw',
        truncated: true,
        skill: {
          name: 'demo',
          location: '/skills/SKILL.md',
          text: '',
          contentRef: 'instructions',
          truncated: true,
        },
      },
    ],
  });
  p.read.mockRejectedValueOnce(new Error('读取失败'));
  const view = render(MessageView, {
    ...p,
    toolViews: { user: { 'skill:skill': true } },
  });
  expect(await view.findByRole('alert')).toHaveTextContent('读取失败');
  await fireEvent.click(view.getByRole('button', { name: '重试读取全文' }));
  expect(await view.findByText('完整内容')).toBeVisible();
});
it('keeps assistant Markdown outside user folding rules', () => {
  const view = render(
    MessageView,
    props({ role: 'assistant', text: '# 回答\n\n' + '正文'.repeat(600) }),
  );
  expect(view.getByRole('heading', { name: '回答' })).toBeVisible();
  expect(view.queryByRole('button', { name: '展开更多' })).toBeNull();
});
