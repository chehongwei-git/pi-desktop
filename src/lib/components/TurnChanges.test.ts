/** 验证轮次导航与文件选择，不依赖宿主或在线模型。 */
import { render, fireEvent, screen } from '@testing-library/svelte';
import { describe, it, expect, vi } from 'vitest';
import TurnChanges from './TurnChanges.svelte';
import type { TurnChanges as Turn } from '../types';
const turns: Turn[] = [
  {
    id: 'new',
    title: '修改布局',
    state: 'done',
    warnings: [],
    files: [
      {
        path: 'src/App.svelte',
        kind: 'modified',
        added: 2,
        removed: 1,
        binary: false,
        contentRef: 'diff-new',
      },
    ],
  },
  {
    id: 'old',
    title: '添加文件',
    state: 'stopped',
    warnings: [],
    files: [
      {
        path: 'old.ts',
        kind: 'added',
        added: 3,
        removed: 0,
        binary: false,
        contentRef: 'diff-old',
      },
    ],
  },
];
describe('轮次变更', () => {
  it('defaults collapsed and opens merged file differences', async () => {
    const onselect = vi.fn();
    render(TurnChanges, { turns, onselect, onretry: vi.fn() });
    expect(screen.queryByText('App.svelte')).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: /代码变更/ }));
    await fireEvent.click(screen.getByRole('button', { name: /App.svelte/ }));
    expect(onselect.mock.calls[0][0].tool.diffRef).toBe('diff-new');
    await fireEvent.click(screen.getByLabelText('选择变更轮次'));
    await fireEvent.click(screen.getByRole('button', { name: /前 1 轮/ }));
    expect(screen.getByText('任务已停止，以下为已保存的修改')).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: /old.ts/ }));
    expect(onselect.mock.calls[1][0].tool.diffRef).toBe('diff-old');
    await fireEvent.keyDown(screen.getByRole('region', { name: '变更文件' }), {
      key: 'Escape',
    });
    expect(screen.queryByText('old.ts')).toBeNull();
  });
});
