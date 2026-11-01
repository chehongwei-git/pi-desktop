/** 验证扩展文本展示、进度刷新与用户展开状态，完成状态始终只读。 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import PlanTodos from './PlanTodos.svelte';
afterEach(cleanup);
describe('plan todos', () => {
  it('summarizes progress and the first unfinished step without showing technical keys', async () => {
    const view = render(PlanTodos, {
      lines: ['☑ 已完成检查', '☐ 实现界面', '☐ 执行验证'],
    });
    expect(view.getByRole('progressbar')).toHaveAttribute('value', '1');
    expect(view.getByText('1 / 3', { selector: 'span' })).toBeVisible();
    expect(view.getByText('接下来 · 2')).toBeVisible();
    expect(view.getByText('执行验证')).not.toBeVisible();
    expect(view.queryByRole('checkbox')).not.toBeInTheDocument();
    await fireEvent.click(view.getByRole('button', { name: '展开全部' }));
    expect(view.getAllByRole('listitem')).toHaveLength(3);
    expect(view.getByRole('button', { name: '收起步骤' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await view.rerender({
      lines: ['☑ 已完成检查', '☑ 实现界面', '☐ 执行验证'],
    });
    expect(view.getByRole('button', { name: '收起步骤' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(view.getByText('接下来 · 3')).toBeVisible();
    const list = view.getByRole('group', { name: '计划步骤' });
    await fireEvent.keyDown(list, { key: 'Escape' });
    expect(view.getByRole('button', { name: '展开全部' })).toHaveFocus();
    expect(list).not.toBeVisible();
  });
  it('shows completion and preserves unknown nonempty lines without inventing completion', async () => {
    const view = render(PlanTodos, { lines: ['☑ 全部完成'] });
    expect(view.getByText('全部步骤已完成')).toBeVisible();
    await view.rerender({ lines: ['', '  ', '未来扩展格式', '☑ 已完成'] });
    expect(view.getByText('1 / 2', { selector: 'span' })).toBeVisible();
    expect(view.getAllByText('未来扩展格式')[0]).toBeVisible();
    await view.rerender({ lines: [] });
    expect(view.queryByRole('region')).not.toBeInTheDocument();
  });
});
