import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BuiltinCommandDialog from './BuiltinCommandDialog.svelte';
import { Desktop } from '../state/desktop.svelte';
import { bridge } from '../client';

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (
    this: HTMLDialogElement,
  ) {
    this.open = true;
  });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.open = false;
  });
});
afterEach(cleanup);
function fixture() {
  const action = vi.fn().mockResolvedValue({});
  const desktop = new Desktop({ ...bridge, action });
  desktop.connection = 'ready';
  desktop.models = [{ provider: 'mock', id: 'model', name: 'Mock' }];
  return { desktop, action };
}
describe('builtin command execution', () => {
  it('selects a model using the desktop action instead of prompting the agent', async () => {
    const { desktop, action } = fixture();
    const view = render(BuiltinCommandDialog, {
      desktop,
      name: 'model',
      args: '',
      onclose: vi.fn(),
    });
    await waitFor(() =>
      expect(view.getByRole('button', { name: '执行' })).toBeEnabled(),
    );
    await fireEvent.click(view.getByRole('button', { name: '执行' }));
    await waitFor(() =>
      expect(action).toHaveBeenCalledWith('', {
        type: 'set_model',
        provider: 'mock',
        model: 'model',
      }),
    );
    expect(
      action.mock.calls.every(([, command]) => command.type !== 'prompt'),
    ).toBe(true);
  });
  it('keeps compact instructions on failure and refreshes authoritative history on success', async () => {
    const { desktop, action } = fixture();
    const refresh = vi
      .spyOn(desktop, 'refreshCommandSession')
      .mockResolvedValue();
    action.mockRejectedValueOnce(new Error('compact failed'));
    const view = render(BuiltinCommandDialog, {
      desktop,
      name: 'compact',
      args: '保留代码变更',
      onclose: vi.fn(),
    });
    await waitFor(() =>
      expect(view.getByRole('button', { name: '执行' })).toBeEnabled(),
    );
    expect(action).not.toHaveBeenCalled();
    await fireEvent.click(view.getByRole('button', { name: '执行' }));
    await waitFor(() =>
      expect(view.getByRole('alert')).toHaveTextContent('compact failed'),
    );
    expect(view.getByRole('textbox')).toHaveValue('保留代码变更');
    expect(refresh).not.toHaveBeenCalled();
    await fireEvent.click(view.getByRole('button', { name: '执行' }));
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(action).toHaveBeenLastCalledWith('', {
      type: 'compact',
      instructions: '保留代码变更',
    });
  });
  it('does not refresh the session when a clone is cancelled by an extension', async () => {
    const { desktop, action } = fixture();
    action.mockResolvedValue({ cancelled: true });
    const refresh = vi
      .spyOn(desktop, 'refreshCommandSession')
      .mockResolvedValue();
    const view = render(BuiltinCommandDialog, {
      desktop,
      name: 'clone',
      args: '',
      onclose: vi.fn(),
    });
    await waitFor(() =>
      expect(view.getByText('操作已被 Pi 扩展取消。')).toBeInTheDocument(),
    );
    expect(refresh).not.toHaveBeenCalled();
  });
  it('explains terminal-only commands without calling RPC', async () => {
    const { desktop, action } = fixture();
    const view = render(BuiltinCommandDialog, {
      desktop,
      name: 'login',
      args: 'anthropic',
      onclose: vi.fn(),
    });
    await waitFor(() =>
      expect(view.getByText(/\/login anthropic/)).toBeInTheDocument(),
    );
    expect(action).not.toHaveBeenCalled();
  });
});
