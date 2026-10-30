/** 组件行为测试：真实 textarea 键盘事件覆盖 IME 与显式运行中发送模式。 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, it, expect, vi } from 'vitest';
import Composer from './Composer.svelte';
afterEach(cleanup);
describe('composer', () => {
  it('shows executable builtins and discovered commands, with keyboard completion and dismissal', async () => {
    const onsend = vi.fn();
    const view = render(Composer, {
      value: '/',
      onsend,
      onstop: vi.fn(),
      commands: [{ name: 'skill:review', source: 'skill' }],
    });
    const input = view.getByRole('textbox');
    expect(view.getAllByRole('option')).toHaveLength(16);
    expect(
      view.queryByRole('option', { name: /\/hotkeys/ }),
    ).not.toBeInTheDocument();
    expect(view.getByRole('button', { name: '导出' })).toBeInTheDocument();
    expect(
      view.queryByRole('option', { name: /\/login/ }),
    ).not.toBeInTheDocument();
    expect(
      view.queryByRole('option', { name: /\/share/ }),
    ).not.toBeInTheDocument();
    expect(view.getByRole('option', { name: /\/quit/ })).toBeInTheDocument();
    await fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(
      view.getByRole('option', { name: /\/skill:review/ }),
    ).toHaveAttribute('aria-selected', 'true');
    await fireEvent.keyDown(input, { key: 'Tab' });
    expect(input).toHaveValue('/skill:review ');
    expect(onsend).not.toHaveBeenCalled();
    expect(view.queryByRole('listbox')).not.toBeInTheDocument();
    await fireEvent.input(input, { target: { value: '/comp' } });
    await fireEvent.keyDown(input, { key: 'Enter' });
    expect(input).toHaveValue('/compact ');
    expect(onsend).not.toHaveBeenCalled();
    await fireEvent.keyDown(input, { key: 'Enter' });
    expect(onsend).toHaveBeenCalledOnce();
    await fireEvent.input(input, { target: { value: '/' } });
    await fireEvent.keyDown(input, { key: 'Escape' });
    expect(view.queryByRole('listbox')).not.toBeInTheDocument();
    await fireEvent.input(input, { target: { value: '/m' } });
    expect(view.getByRole('listbox')).toBeInTheDocument();
  });
  it('filters categories and searches across categories in Chinese', async () => {
    const view = render(Composer, {
      value: '/',
      onsend: vi.fn(),
      onstop: vi.fn(),
      commands: [{ name: 'review', description: '检查代码', source: 'prompt' }],
    });
    await fireEvent.click(view.getByRole('button', { name: '模型与思考' }));
    expect(view.getAllByRole('option')).toHaveLength(2);
    expect(
      view.queryByRole('option', { name: /\/new / }),
    ).not.toBeInTheDocument();
    await fireEvent.input(view.getByRole('textbox'), {
      target: { value: '/检查' },
    });
    expect(view.getByRole('option', { name: /review/ })).toBeInTheDocument();
    await fireEvent.input(view.getByRole('textbox'), {
      target: { value: '/' },
    });
    expect(view.getAllByRole('option')).toHaveLength(16);
  });
  it('ignores slash completion during IME and hides the menu for arguments or disabled input', async () => {
    const view = render(Composer, {
      value: '/model',
      onsend: vi.fn(),
      onstop: vi.fn(),
    });
    const input = view.getByRole('textbox');
    await fireEvent.compositionStart(input);
    await fireEvent.keyDown(input, { key: 'Enter' });
    expect(input).toHaveValue('/model');
    await fireEvent.compositionEnd(input);
    await fireEvent.input(input, { target: { value: '/model provider/id' } });
    expect(view.queryByRole('listbox')).not.toBeInTheDocument();
    await view.rerender({ value: '/', disabled: true });
    expect(view.queryByRole('listbox')).not.toBeInTheDocument();
  });
  it('shows compact syntax while submitting the command through the composer', async () => {
    const onsend = vi.fn();
    const view = render(Composer, {
      value: '/compact 保留代码',
      onsend,
      onstop: vi.fn(),
    });
    expect(view.getByText(/语法：\/compact/)).toBeInTheDocument();
    expect(view.queryByRole('dialog')).not.toBeInTheDocument();
    await fireEvent.keyDown(view.getByRole('textbox'), { key: 'Enter' });
    expect(onsend).toHaveBeenCalledOnce();
  });
  it('does not submit IME confirmation but submits ordinary Enter', async () => {
    const onsend = vi.fn();
    const view = render(Composer, { value: '你好', onsend, onstop: vi.fn() });
    const input = view.getByRole('textbox');
    await fireEvent.compositionStart(input);
    await fireEvent.keyDown(input, { key: 'Enter', keyCode: 13 });
    expect(onsend).not.toHaveBeenCalled();
    await fireEvent.compositionEnd(input);
    await fireEvent.keyDown(input, { key: 'Enter', keyCode: 13 });
    expect(onsend).toHaveBeenCalledOnce();
  });
  it('blocks steering and follow-up while submitting or disabled, but allows stopping a pending send', async () => {
    const onsend = vi.fn();
    const onstop = vi.fn();
    const view = render(Composer, {
      value: 'later',
      running: true,
      submitting: true,
      onsend,
      onstop,
    });
    expect(view.getByRole('button', { name: '发送引导' })).toBeDisabled();
    expect(view.getByRole('button', { name: '完成后发送' })).toBeDisabled();
    await fireEvent.keyDown(view.getByRole('textbox'), { key: 'Enter' });
    expect(onsend).not.toHaveBeenCalled();
    await fireEvent.click(view.getByRole('button', { name: '停止任务' }));
    expect(onstop).toHaveBeenCalledOnce();
    await view.rerender({ disabled: true, submitting: false });
    expect(view.getByRole('button', { name: '发送引导' })).toBeDisabled();
    expect(view.getByRole('button', { name: '完成后发送' })).toBeDisabled();
    expect(view.getByRole('button', { name: '停止任务' })).toBeDisabled();
  });
  it('sends steering on Enter while running and exposes separate follow-up and stop controls', async () => {
    const onsend = vi.fn();
    const onstop = vi.fn();
    const view = render(Composer, {
      value: 'later',
      running: true,
      onsend,
      onstop,
    });
    await fireEvent.keyDown(view.getByRole('textbox'), { key: 'Enter' });
    expect(onsend).toHaveBeenLastCalledWith('steer');
    await fireEvent.click(view.getByRole('button', { name: '发送引导' }));
    expect(onsend).toHaveBeenLastCalledWith('steer');
    await fireEvent.click(view.getByText('完成后发送'));
    expect(onsend).toHaveBeenLastCalledWith('followUp');
    await fireEvent.click(view.getByRole('button', { name: '停止任务' }));
    expect(onstop).toHaveBeenCalledOnce();
  });
});
