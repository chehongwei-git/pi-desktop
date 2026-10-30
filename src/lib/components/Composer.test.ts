/** 组件行为测试：真实 textarea 键盘事件覆盖 IME 与显式运行中发送模式。 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, it, expect, vi } from 'vitest';
import Composer from './Composer.svelte';
afterEach(cleanup);
describe('composer', () => {
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
