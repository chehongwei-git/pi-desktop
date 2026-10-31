import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ProjectPicker from './ProjectPicker.svelte';

afterEach(cleanup);
const projects = [{ path: '/work/alpha' }, { path: '/work/beta' }];

describe('project picker', () => {
  it.each([
    ['切换项目', /beta/, '/work/beta'],
    ['新建项目', /新建项目/, null],
    ['不在此项目工作', /不在此项目工作/, ''],
  ] as const)(
    'keeps %s clickable when the browser does not focus buttons on mouse down',
    async (_label, name, path) => {
      const onselect = vi.fn();
      const oncreate = vi.fn();
      const view = render(ProjectPicker, {
        projects,
        project: '/work/alpha',
        onselect,
        oncreate,
      });
      await fireEvent.click(
        view.getByRole('button', { name: '选择新对话项目' }),
      );
      expect(view.getByRole('textbox', { name: '搜索项目' })).toHaveFocus();
      const button = view.getByRole('button', { name });
      // jsdom 与 WebKit 一样，不会因 fireEvent.mouseDown 自动聚焦按钮。
      await fireEvent.mouseDown(button, { button: 0 });
      expect(button).toHaveFocus();
      expect(button).toBeInTheDocument();
      await fireEvent.mouseUp(button, { button: 0 });
      await fireEvent.click(button);
      if (path === null) expect(oncreate).toHaveBeenCalledOnce();
      else expect(onselect).toHaveBeenCalledExactlyOnceWith(path);
      expect(view.queryByRole('region')).not.toBeInTheDocument();
      expect(
        view.getByRole('button', { name: '选择新对话项目' }),
      ).toHaveFocus();
    },
  );

  it('opens with the keyboard, navigates results and restores trigger focus', async () => {
    const onselect = vi.fn();
    const view = render(ProjectPicker, {
      projects,
      project: '/work/alpha',
      onselect,
      oncreate: vi.fn(),
    });
    const trigger = view.getByRole('button', { name: '选择新对话项目' });
    trigger.focus();
    await fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const search = view.getByRole('textbox', { name: '搜索项目' });
    expect(search).toHaveFocus();
    await fireEvent.keyDown(search, { key: 'ArrowDown' });
    const current = view.getByRole('button', { name: /alpha/ });
    expect(current).toHaveFocus();
    expect(current).toHaveAttribute('aria-pressed', 'true');
    await fireEvent.keyDown(current, { key: 'Escape' });
    expect(trigger).toHaveFocus();
    expect(view.queryByRole('region')).not.toBeInTheDocument();
    expect(onselect).not.toHaveBeenCalled();
  });

  it('searches paths, ignores IME confirmation and selects the result on Enter', async () => {
    const onselect = vi.fn();
    const view = render(ProjectPicker, {
      projects,
      project: '/work/alpha',
      onselect,
      oncreate: vi.fn(),
    });
    await fireEvent.click(view.getByRole('button', { name: '选择新对话项目' }));
    const search = view.getByRole('textbox', { name: '搜索项目' });
    await fireEvent.input(search, { target: { value: 'BETA' } });
    expect(view.getByRole('status')).toHaveTextContent('1 个项目');
    await fireEvent.keyDown(search, { key: 'Enter', isComposing: true });
    expect(onselect).not.toHaveBeenCalled();
    await fireEvent.keyDown(search, { key: 'Enter' });
    expect(onselect).toHaveBeenCalledExactlyOnceWith('/work/beta');
  });

  it('keeps empty searches open and avoids reconnecting the current project', async () => {
    const onselect = vi.fn();
    const view = render(ProjectPicker, {
      projects,
      project: '/work/alpha',
      onselect,
      oncreate: vi.fn(),
    });
    await fireEvent.click(view.getByRole('button', { name: '选择新对话项目' }));
    const search = view.getByRole('textbox', { name: '搜索项目' });
    await fireEvent.input(search, { target: { value: 'missing' } });
    await fireEvent.keyDown(search, { key: 'Enter' });
    expect(view.getByText('没有找到匹配项目')).toBeInTheDocument();
    expect(onselect).not.toHaveBeenCalled();
    await fireEvent.input(search, { target: { value: 'alpha' } });
    await fireEvent.click(view.getByRole('button', { name: /alpha/ }));
    expect(view.queryByRole('region')).not.toBeInTheDocument();
    expect(onselect).not.toHaveBeenCalled();
  });
});
