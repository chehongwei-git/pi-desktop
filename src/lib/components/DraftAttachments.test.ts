/** 验证原地预览与重复附件移除，避免删除/关闭造成草稿焦点丢失。 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import DraftAttachments from './DraftAttachments.svelte';
import { imageAttachment } from '../attachments';
afterEach(cleanup);
const first = {
  id: 'same',
  name: '截图.png',
  mimeType: 'image/png',
  data: 'data',
};
it('switches previews, restores focus on Escape and closes on context change', async () => {
  const view = render(DraftAttachments, {
    attachments: [first, { ...first, id: 'other', name: '第二张.png' }].map(
      imageAttachment,
    ),
    historyKey: 'a',
    onempty: vi.fn(),
  });
  const thumbnail = view.getByRole('button', { name: '放大截图.png（1）' });
  await fireEvent.click(thumbnail);
  expect(view.getByAltText('预览：截图.png')).toBeVisible();
  await fireEvent.click(
    view.getByRole('button', { name: '放大第二张.png（2）' }),
  );
  expect(view.getByAltText('预览：第二张.png')).toBeVisible();
  await fireEvent.click(view.getByRole('button', { name: '收起预览' }));
  expect(
    view.getByRole('button', { name: '放大第二张.png（2）' }),
  ).toHaveFocus();
  await fireEvent.click(thumbnail);
  await fireEvent.keyDown(thumbnail, { key: 'Escape' });
  expect(thumbnail).toHaveFocus();
  expect(view.queryByRole('region')).not.toBeInTheDocument();
  await fireEvent.click(thumbnail);
  await view.rerender({ historyKey: 'b' });
  expect(view.queryByRole('region')).not.toBeInTheDocument();
});
it('removes only one duplicate, closes its preview, and returns focus to input when empty', async () => {
  const onempty = vi.fn();
  const view = render(DraftAttachments, {
    attachments: [first, first].map(imageAttachment),
    onempty,
  });
  await fireEvent.click(
    view.getByRole('button', { name: '放大截图.png（2）' }),
  );
  await fireEvent.click(
    view.getAllByRole('button', { name: '移除截图.png' })[1],
  );
  expect(view.getAllByRole('button', { name: '移除截图.png' })).toHaveLength(1);
  expect(view.queryByRole('region')).not.toBeInTheDocument();
  expect(view.getByRole('button', { name: '放大截图.png（1）' })).toHaveFocus();
  await fireEvent.click(view.getByRole('button', { name: '移除截图.png' }));
  expect(onempty).toHaveBeenCalledOnce();
});
it('shows an inline fallback when image decoding fails', async () => {
  const view = render(DraftAttachments, {
    attachments: [imageAttachment(first)],
    onempty: vi.fn(),
  });
  await fireEvent.error(view.getByAltText('截图.png'));
  expect(view.getByText('无法预览')).toBeVisible();
  await fireEvent.click(
    view.getByRole('button', { name: '放大截图.png（1）' }),
  );
  expect(view.getByRole('status')).toHaveTextContent('此图片无法预览');
});

it('shows complete paths inline, edits without replacing another instance and preserves keyboard focus', async () => {
  const original = {
    id: 'file',
    kind: 'path' as const,
    path: '/tmp/很长的需求文档.pdf',
    name: '很长的需求文档.pdf',
    directory: false,
  };
  const view = render(DraftAttachments, {
    attachments: [original, { ...original, id: 'duplicate' }],
    onempty: vi.fn(),
  });
  const card = view.getByRole('button', {
    name: '查看文件引用：很长的需求文档.pdf（1）',
  });
  await fireEvent.click(card);
  expect(view.getByRole('region', { name: '文件引用详情' })).toHaveTextContent(
    original.path,
  );
  await fireEvent.click(view.getByRole('button', { name: '编辑路径' }));
  const input = view.getByLabelText('完整路径');
  expect(input).toHaveFocus();
  await fireEvent.input(input, { target: { value: 'relative.txt' } });
  await fireEvent.keyDown(input, { key: 'Enter' });
  expect(view.getByRole('alert')).toHaveTextContent('绝对路径');
  const path = /Win/i.test(navigator.platform || navigator.userAgent)
    ? 'C:\\work\\新文件.txt'
    : '/tmp/新文件.txt';
  await fireEvent.input(input, { target: { value: path } });
  await fireEvent.keyDown(input, { key: 'Enter' });
  const edited = view.getByRole('button', {
    name: '查看文件引用：新文件.txt（1）',
  });
  expect(edited).toHaveFocus();
  expect(edited.dataset.attachment).not.toBe(original.id);
  expect(
    view.getByRole('button', { name: '查看文件引用：很长的需求文档.pdf（2）' }),
  ).toBeInTheDocument();
  await fireEvent.keyDown(edited, { key: 'Escape' });
  expect(view.queryByRole('region')).not.toBeInTheDocument();
});

it('copies the exact path and cancels path editing without changing the reference', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', {
    ...navigator,
    clipboard: { writeText },
    platform: 'Linux',
  });
  try {
    const item = {
      id: 'path',
      kind: 'path' as const,
      path: '/tmp/a "b".txt',
      name: 'a "b".txt',
      directory: false,
      notice: '此格式按路径引用',
    };
    const view = render(DraftAttachments, {
      attachments: [item],
      onempty: vi.fn(),
    });
    expect(view.getByText(item.notice)).toBeVisible();
    await fireEvent.click(view.getByRole('button', { name: /查看文件引用/ }));
    await fireEvent.click(view.getByRole('button', { name: '复制路径' }));
    expect(writeText).toHaveBeenCalledWith(item.path);
    await fireEvent.click(view.getByRole('button', { name: '编辑路径' }));
    const input = view.getByLabelText('完整路径');
    await fireEvent.input(input, { target: { value: '/tmp/changed' } });
    await fireEvent.keyDown(input, { key: 'Escape' });
    expect(view.getByRole('region')).toHaveTextContent(item.path);
    expect(view.getByRole('button', { name: /查看文件引用/ })).toHaveFocus();
  } finally {
    vi.unstubAllGlobals();
  }
});
