/** 历史召回覆盖真实键盘、异步竞争和多行编辑，避免覆盖用户草稿。 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Composer from './Composer.svelte';
import type { Message, HistoryPage } from '../types';
afterEach(cleanup);
const message = (id: string, text = id): Message => ({
  id,
  text,
  role: 'user',
  thinking: '',
  contentRef: null,
  status: 'done',
  name: null,
});
function setup(messages = [message('旧提示词'), message('新提示词')]) {
  const onhistory = vi
    .fn()
    .mockResolvedValue({ messages, before: 0, hasMore: false });
  const onsend = vi.fn();
  const view = render(Composer, {
    onhistory,
    onsend,
    onstop: vi.fn(),
    historyKey: 'a',
  });
  return {
    view,
    input: view.getByRole('textbox') as HTMLTextAreaElement,
    onhistory,
    onsend,
  };
}
async function press(input: HTMLTextAreaElement, key: string, value: string) {
  await fireEvent.keyDown(input, { key });
  await waitFor(() => expect(input).toHaveValue(value));
}
describe('提示词历史', () => {
  it('连续向上召回，向下恢复空输入，边界不循环，修改后可以发送', async () => {
    const { input, onsend } = setup();
    await press(input, 'ArrowUp', '新提示词');
    await press(input, 'ArrowUp', '旧提示词');
    await press(input, 'ArrowUp', '旧提示词');
    await press(input, 'ArrowDown', '新提示词');
    await press(input, 'ArrowDown', '');
    await press(input, 'ArrowUp', '新提示词');
    await fireEvent.input(input, { target: { value: '修改后的要求' } });
    await press(input, 'ArrowUp', '修改后的要求');
    await fireEvent.keyDown(input, { key: 'Enter' });
    expect(onsend).toHaveBeenCalledOnce();
  });
  it('分页跨过没有用户消息的页面，并按 ID 去重，重复文本仍保留', async () => {
    const { input, onhistory } = setup();
    onhistory
      .mockResolvedValueOnce({
        messages: [message('3', '重复')],
        before: 50,
        hasMore: true,
      })
      .mockResolvedValueOnce({ messages: [], before: 25, hasMore: true })
      .mockResolvedValueOnce({
        messages: [message('1', '最早'), message('2', '重复'), message('3')],
        before: 0,
        hasMore: false,
      });
    await press(input, 'ArrowUp', '重复');
    await fireEvent.keyDown(input, { key: 'ArrowUp' });
    await waitFor(() => expect(onhistory).toHaveBeenCalledTimes(3));
    // 相同文本无法表示异步翻阅完成，须等待加载状态收起后再按下一次。
    await waitFor(() =>
      expect(document.querySelector('[role="status"]')).toBeNull(),
    );
    await press(input, 'ArrowUp', '最早');
    expect(onhistory.mock.calls).toEqual([[], [50], [25]]);
  });
  it('草稿、修饰键、选区、输入法和命令菜单保留原来的行为', async () => {
    const { input, onhistory } = setup();
    await fireEvent.input(input, { target: { value: '草稿' } });
    await press(input, 'ArrowUp', '草稿');
    await fireEvent.input(input, { target: { value: '' } });
    for (const modifier of ['shiftKey', 'ctrlKey', 'metaKey', 'altKey'])
      await fireEvent.keyDown(input, { key: 'ArrowUp', [modifier]: true });
    await fireEvent.compositionStart(input);
    await press(input, 'ArrowUp', '');
    await fireEvent.compositionEnd(input);
    await fireEvent.keyDown(input, { key: 'ArrowUp', isComposing: true });
    await fireEvent.input(input, { target: { value: '/' } });
    await fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(onhistory).not.toHaveBeenCalled();
    await fireEvent.input(input, { target: { value: '' } });
    await press(input, 'ArrowUp', '新提示词');
    input.setSelectionRange(0, 2);
    await press(input, 'ArrowUp', '新提示词');
  });
  it('多行内部不翻历史，首行和末行支持切换，召回命令不会抢走方向键', async () => {
    const { input } = setup([
      message('old', '/model'),
      message('new', '第一行\n第二行\n第三行'),
    ]);
    await press(input, 'ArrowUp', '第一行\n第二行\n第三行');
    input.setSelectionRange(5, 5);
    await press(input, 'ArrowUp', '第一行\n第二行\n第三行');
    await press(input, 'ArrowDown', '第一行\n第二行\n第三行');
    input.setSelectionRange(0, 0);
    await press(input, 'ArrowUp', '/model');
    await press(input, 'ArrowDown', '第一行\n第二行\n第三行');
    expect(input.selectionStart).toBe(input.value.length);
    await press(input, 'ArrowDown', '');
  });
  it('读取失败可以重试，读取期间输入和切换会话使旧结果失效', async () => {
    const { view, input, onhistory } = setup();
    onhistory.mockRejectedValueOnce(new Error('读取失败'));
    await fireEvent.keyDown(input, { key: 'ArrowUp' });
    await waitFor(() =>
      expect(view.getByRole('alert')).toHaveTextContent('读取失败'),
    );
    await press(input, 'ArrowUp', '新提示词');
    await view.rerender({ value: '', historyKey: 'b' });
    let release!: (page: HistoryPage) => void;
    onhistory.mockImplementationOnce(
      () =>
        new Promise<HistoryPage>((resolve) => {
          release = resolve;
        }),
    );
    await fireEvent.keyDown(input, { key: 'ArrowUp' });
    await fireEvent.input(input, { target: { value: '正在写' } });
    release({ messages: [message('迟到')], before: 0, hasMore: false });
    await waitFor(() => expect(input).toHaveValue('正在写'));
    await view.rerender({ value: '', historyKey: 'c' });
    onhistory.mockImplementationOnce(
      () =>
        new Promise<HistoryPage>((resolve) => {
          release = resolve;
        }),
    );
    await fireEvent.keyDown(input, { key: 'ArrowUp' });
    await view.rerender({ value: '另一个会话', historyKey: 'd' });
    release({ messages: [message('旧会话')], before: 0, hasMore: false });
    await waitFor(() => expect(input).toHaveValue('另一个会话'));
  });
});
