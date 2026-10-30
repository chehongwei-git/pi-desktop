/** 组件行为测试：真实 textarea 键盘事件覆盖 IME 与显式运行中发送模式。 */
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
  it('requires a steer/followUp decision while running', async () => {
    const onsend = vi.fn();
    const view = render(Composer, {
      value: 'later',
      running: true,
      onsend,
      onstop: vi.fn(),
    });
    await fireEvent.keyDown(view.getByRole('textbox'), { key: 'Enter' });
    expect(onsend).not.toHaveBeenCalled();
    await fireEvent.click(view.getByText('完成后发送'));
    expect(onsend).toHaveBeenCalledWith('followUp');
  });
});
