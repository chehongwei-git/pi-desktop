/** 验证工具参数中的最终方案可直接阅读，以及分块、失败恢复和迟到读取。 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import PlanMessage from './PlanMessage.svelte';
import type { Message } from '../types';

afterEach(cleanup);
const message: Message = {
  id: 'plan',
  role: 'toolResult',
  name: 'plan_mode_complete',
  text: 'Plan submitted',
  thinking: '',
  contentRef: null,
  status: 'done',
  tool: { callId: 'plan', name: 'plan_mode_complete', argsRef: 'args' },
};
function props(
  read = vi
    .fn()
    .mockResolvedValue({
      text: JSON.stringify({ plan: '# 实施方案\n\n- 保留草稿' }),
      next: 0,
      done: true,
    }),
) {
  return {
    message,
    read,
    onerror: vi.fn(),
    toolViews: {},
    ontoggletool: vi.fn(),
  };
}
it('renders full Markdown from paged arguments without opening tool details', async () => {
  const json = JSON.stringify({ plan: '# 实施方案\n\n- 保留草稿' });
  const read = vi
    .fn()
    .mockResolvedValueOnce({ text: json.slice(0, 12), next: 12, done: false })
    .mockResolvedValueOnce({ text: json.slice(12), next: 30, done: true });
  const view = render(PlanMessage, props(read));
  expect(await view.findByRole('heading', { name: '实施方案' })).toBeVisible();
  expect(view.getByText('保留草稿')).toBeVisible();
  expect(view.getByRole('button', { name: '复制消息' })).toBeVisible();
  expect(view.getByRole('button', { name: /查看详情/ })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  expect(read.mock.calls).toEqual([
    ['args', 0],
    ['args', 12],
  ]);
});
it('retries failed reads inline and does not label a failed submission as complete', async () => {
  const options = props();
  options.read.mockRejectedValueOnce(new Error('读取失败'));
  const view = render(PlanMessage, {
    ...options,
    message: { ...message, status: 'error' },
  });
  expect(await view.findByRole('alert')).toHaveTextContent('读取失败');
  expect(view.getByText('计划提交失败')).toBeVisible();
  await fireEvent.click(view.getByRole('button', { name: '重试读取计划' }));
  expect(await view.findByRole('heading', { name: '实施方案' })).toBeVisible();
});
it('discards stale references when switching plans', async () => {
  let release!: (value: unknown) => void;
  const read = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    )
    .mockResolvedValue({
      text: JSON.stringify({ plan: '# 新方案' }),
      done: true,
      next: 0,
    });
  const options = props(read);
  const view = render(PlanMessage, options);
  await waitFor(() => expect(read).toHaveBeenCalled());
  await view.rerender({
    ...options,
    message: { ...message, tool: { ...message.tool!, argsRef: 'new' } },
  });
  expect(await view.findByRole('heading', { name: '新方案' })).toBeVisible();
  release({ text: JSON.stringify({ plan: '# 旧方案' }), done: true, next: 0 });
  await Promise.resolve();
  expect(
    view.queryByRole('heading', { name: '旧方案' }),
  ).not.toBeInTheDocument();
});
it.each([
  { text: '{}', done: true, next: 0 },
  { text: '{', done: false, next: 0 },
])(
  'shows recoverable feedback for missing plans or stalled pages: %j',
  async (page) => {
    const view = render(PlanMessage, props(vi.fn().mockResolvedValue(page)));
    expect(await view.findByRole('alert')).toBeVisible();
    expect(view.getByRole('button', { name: '重试读取计划' })).toBeVisible();
  },
);
