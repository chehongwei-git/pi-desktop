/** 验证扩展文本展示、进度刷新与用户展开状态，完成状态始终只读。 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PlanTodos from './PlanTodos.svelte';
afterEach(cleanup);
describe('plan todos', () => {
  it('finishes processed progress without claiming a restricted step succeeded', () => {
    const view = render(PlanTodos, {
      lines: [
        '☑ 实现完成',
        '⊘ 最后验证（未完成：缺少环境）',
        'ℹ 计划已结束，部分步骤受条件限制未完成',
      ],
      oncontinue: vi.fn(),
      onstop: vi.fn(),
    });
    expect(view.getByRole('progressbar')).toHaveAttribute('value', '2');
    expect(view.getByText('2 / 2 已处理')).toBeVisible();
    expect(view.getByText('计划已结束 · 1 步完成，1 步受限')).toBeVisible();
    expect(view.queryByText('全部步骤已完成')).not.toBeInTheDocument();
    expect(
      view.queryByRole('button', { name: '继续执行' }),
    ).not.toBeInTheDocument();
  });
  it('separates execution feedback from steps and prevents duplicate continuation', async () => {
    let release!: () => void;
    const oncontinue = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const onstop = vi.fn().mockResolvedValue(undefined);
    const view = render(PlanTodos, {
      lines: ['☑ 前四步', '☐ 最后验证', 'ℹ 等待处理：测试环境缺失'],
      oncontinue,
      onstop,
    });
    expect(view.getByText('1 / 2', { selector: 'span' })).toBeVisible();
    expect(view.getByRole('status')).toHaveTextContent('测试环境缺失');
    await fireEvent.click(view.getByRole('button', { name: '继续执行' }));
    expect(view.getByRole('button', { name: '正在提交…' })).toBeDisabled();
    expect(oncontinue).toHaveBeenCalledOnce();
    release();
    await view.rerender({
      lines: ['☑ 前四步', '☐ 最后验证'],
      running: true,
      oncontinue,
      onstop,
    });
    expect(
      view.queryByRole('button', { name: '继续执行' }),
    ).not.toBeInTheDocument();
    expect(view.getByText('正在执行 · 2')).toBeVisible();
  });
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
