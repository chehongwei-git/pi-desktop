/** 验证原地预览与重复附件移除，避免删除/关闭造成草稿焦点丢失。 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import ImageAttachments from './ImageAttachments.svelte';
afterEach(cleanup);
const first = {
  id: 'same',
  name: '截图.png',
  mimeType: 'image/png',
  data: 'data',
};
it('switches previews, restores focus on Escape and closes on context change', async () => {
  const view = render(ImageAttachments, {
    images: [first, { ...first, id: 'other', name: '第二张.png' }],
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
  const view = render(ImageAttachments, { images: [first, first], onempty });
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
  const view = render(ImageAttachments, { images: [first], onempty: vi.fn() });
  await fireEvent.error(view.getByAltText('截图.png'));
  expect(view.getByText('无法预览')).toBeVisible();
  await fireEvent.click(
    view.getByRole('button', { name: '放大截图.png（1）' }),
  );
  expect(view.getByRole('status')).toHaveTextContent('此图片无法预览');
});
