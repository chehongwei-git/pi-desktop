import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ModelControls from './ModelControls.svelte';
import { Desktop } from '../state/desktop.svelte';
import { bridge } from '../client';

afterEach(cleanup);
function fixture() {
  const action = vi.fn().mockResolvedValue({});
  const desktop = new Desktop({ ...bridge, action });
  desktop.connection = 'ready';
  desktop.draft = '保留草稿';
  desktop.models = [
    { provider: 'test', id: 'a', name: 'A' },
    { provider: 'test', id: 'b', name: 'B' },
  ];
  desktop.snapshot = { model: desktop.models[0], thinkingLevel: 'off' };
  desktop.levels = ['off', 'low', 'high'];
  return { desktop, action };
}

describe('composer model controls', () => {
  it('bounds a large catalog and finds models beyond the initial batch', async () => {
    const { desktop } = fixture();
    desktop.models = Array.from({ length: 500 }, (_, index) => ({
      provider: 'test',
      id: `model-${index}`,
      name: `Model ${index}`,
    }));
    desktop.snapshot.model = desktop.models[0];
    const view = render(ModelControls, { desktop });
    await fireEvent.click(view.getByRole('button', { name: '模型' }));
    expect(view.container.querySelectorAll('.model-option')).toHaveLength(80);
    await fireEvent.click(view.getByRole('button', { name: /显示更多/ }));
    expect(view.container.querySelectorAll('.model-option')).toHaveLength(160);
    await fireEvent.input(view.getByRole('textbox', { name: '搜索模型' }), {
      target: { value: 'model-499' },
    });
    expect(view.container.querySelectorAll('.model-option')).toHaveLength(1);
    expect(view.getByTitle('test/model-499')).toBeInTheDocument();
  });
  it('searches models without changing drafts and restores keyboard focus', async () => {
    const { desktop } = fixture();
    const view = render(ModelControls, { desktop });
    const trigger = view.getByRole('button', { name: '模型' });
    await fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const search = view.getByRole('textbox', { name: '搜索模型' });
    await waitFor(() => expect(search).toHaveFocus());
    await fireEvent.input(search, { target: { value: 'missing' } });
    expect(view.getByText(/没有匹配的模型/)).toBeInTheDocument();
    await fireEvent.input(search, { target: { value: 'b' } });
    expect(view.getByTitle('test/b')).toBeInTheDocument();
    expect(
      view.queryByRole('button', { pressed: true }),
    ).not.toBeInTheDocument();
    await fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(view.getByTitle('test/b')).toHaveFocus();
    await fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(trigger).toHaveFocus();
    expect(
      view.queryByRole('region', { name: '选择模型' }),
    ).not.toBeInTheDocument();
    expect(desktop.draft).toBe('保留草稿');
  });
  it('groups models by provider and sorts names without mutating the source', async () => {
    const { desktop } = fixture();
    desktop.models = [
      { provider: 'zeta', id: 'c', name: 'C' },
      { provider: 'alpha', id: 'b', name: 'B' },
      { provider: 'alpha', id: 'a', name: 'A' },
    ];
    const view = render(ModelControls, { desktop });
    await fireEvent.click(view.getByRole('button', { name: '模型' }));
    const groups = [...view.container.querySelectorAll('.model-list section')];
    expect(groups.map((group) => group.getAttribute('aria-label'))).toEqual([
      'alpha',
      'test',
      'zeta',
    ]);
    expect(
      [...groups[0].querySelectorAll('button')].map((option) => option.title),
    ).toEqual(['alpha/a', 'alpha/b']);
    expect(desktop.models.map((model) => model.id)).toEqual(['c', 'b', 'a']);
    expect(view.getByLabelText('模型', { exact: true })).toHaveAttribute(
      'title',
      'test/a',
    );
  });

  it('navigates thinking levels by keyboard and restores focus on Escape', async () => {
    const { desktop } = fixture();
    const view = render(ModelControls, { desktop });
    const trigger = view.getByLabelText('思考级别');
    await fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    await waitFor(() =>
      expect(view.getByRole('menuitemradio', { checked: true })).toHaveFocus(),
    );
    await fireEvent.keyDown(document.activeElement!, { key: 'End' });
    expect(view.getByRole('menuitemradio', { name: /高 high/ })).toHaveFocus();
    await fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(view.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await fireEvent.click(trigger);
    await fireEvent.pointerDown(document.body);
    expect(view.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('keeps the confirmed thinking level and draft on failure', async () => {
    const { desktop, action } = fixture();
    action.mockRejectedValueOnce(new Error('强度切换失败'));
    const view = render(ModelControls, { desktop });
    const trigger = view.getByLabelText('思考级别');
    await fireEvent.click(trigger);
    await fireEvent.click(view.getByRole('menuitemradio', { name: /高 high/ }));
    await waitFor(() =>
      expect(view.getByRole('alert')).toHaveTextContent('强度切换失败'),
    );
    expect(trigger).toHaveTextContent('关闭');
    expect(trigger).toBeEnabled();
    expect(trigger).toHaveFocus();
    expect(desktop.draft).toBe('保留草稿');
  });
  it('switches model and thinking without changing the draft', async () => {
    const { desktop, action } = fixture();
    const setModel = vi
      .spyOn(desktop, 'setModel')
      .mockImplementation(async () => {
        desktop.snapshot.model = desktop.models[1];
      });
    vi.spyOn(desktop, 'syncState').mockImplementation(async () => {
      desktop.snapshot.thinkingLevel = 'high';
    });
    const view = render(ModelControls, { desktop });
    await fireEvent.click(view.getByRole('button', { name: '模型' }));
    await fireEvent.click(view.getByTitle('test/b'));
    await waitFor(() => expect(setModel).toHaveBeenCalledWith('test/b'));
    await fireEvent.click(view.getByLabelText('思考级别'));
    await fireEvent.click(view.getByRole('menuitemradio', { name: /高 high/ }));
    await waitFor(() =>
      expect(action).toHaveBeenCalledWith('', {
        type: 'set_thinking',
        level: 'high',
      }),
    );
    expect(desktop.draft).toBe('保留草稿');
  });

  it('restores confirmed selection on failure and prevents overlapping switches', async () => {
    const { desktop } = fixture();
    let reject!: (cause: Error) => void;
    vi.spyOn(desktop, 'setModel').mockImplementation(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    );
    const view = render(ModelControls, { desktop });
    const model = view.getByLabelText('模型', { exact: true });
    await fireEvent.click(model);
    await fireEvent.click(view.getByTitle('test/b'));
    expect(model).toBeDisabled();
    expect(view.getByLabelText('思考级别')).toBeDisabled();
    reject(new Error('切换失败'));
    await waitFor(() =>
      expect(view.getByRole('alert')).toHaveTextContent('切换失败'),
    );
    expect(model).toHaveAttribute('title', 'test/a');
    expect(model).toBeEnabled();
    expect(desktop.draft).toBe('保留草稿');
  });

  it('keeps the off control visible and disables switching during a task', async () => {
    const { desktop } = fixture();
    desktop.levels = ['off'];
    desktop.run = 'running';
    const view = render(ModelControls, { desktop });
    expect(view.getByLabelText('思考级别')).toHaveTextContent('关闭');
    expect(view.getByLabelText('思考级别')).toBeDisabled();
    expect(view.getByLabelText('模型', { exact: true })).toBeDisabled();
  });
});
