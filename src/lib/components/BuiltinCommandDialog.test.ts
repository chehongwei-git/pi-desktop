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
        thinking: 'off',
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
  it('reloads through the bridge without reconnecting or restoring history', async () => {
    const { desktop, action } = fixture();
    const connect = vi.spyOn(desktop, 'connect');
    const history = vi.spyOn(desktop, 'refreshHistory');
    const sync = vi.spyOn(desktop, 'syncState').mockResolvedValue();
    const metadata = vi.spyOn(desktop, 'refreshMetadata').mockResolvedValue();
    const view = render(BuiltinCommandDialog, {
      desktop,
      name: 'reload',
      args: '',
      onclose: vi.fn(),
    });
    await waitFor(() =>
      expect(view.getByText(/已重载项目资源/)).toBeInTheDocument(),
    );
    expect(action).toHaveBeenCalledWith('', { type: 'reload' });
    expect(connect).not.toHaveBeenCalled();
    expect(history).not.toHaveBeenCalled();
    expect(sync).toHaveBeenCalledOnce();
    expect(metadata).toHaveBeenCalledOnce();
  });
  it.each([
    ['new', 'newSession'],
    ['quit', 'disconnect'],
    ['name', 'rename'],
  ] as const)('/%s uses the desktop operation', async (name, method) => {
    const { desktop } = fixture();
    const operation = vi.spyOn(desktop, method).mockResolvedValue();
    const view = render(BuiltinCommandDialog, {
      desktop,
      name,
      args: name === 'name' ? '新名称' : '',
      onclose: vi.fn(),
    });
    await waitFor(() => expect(operation).toHaveBeenCalledOnce());
    if (name === 'name')
      await waitFor(() =>
        expect(view.getByText('会话名称：新名称')).toBeInTheDocument(),
      );
  });
  it.each([
    [
      'session',
      { type: 'session_stats' },
      { totalMessages: 12 },
      /totalMessages/,
    ],
    ['clone', { type: 'clone' }, { cancelled: false }, /已复制当前会话/],
  ] as const)(
    '/%s executes its RPC and renders the result',
    async (name, command, result, text) => {
      const { desktop, action } = fixture();
      action.mockResolvedValue(result);
      vi.spyOn(desktop, 'refreshCommandSession').mockResolvedValue();
      const view = render(BuiltinCommandDialog, {
        desktop,
        name,
        args: '',
        onclose: vi.fn(),
      });
      await waitFor(() => expect(view.getByText(text)).toBeInTheDocument());
      expect(action).toHaveBeenCalledWith('', command);
    },
  );
  it('exports HTML only after explicit execution', async () => {
    const { desktop, action } = fixture();
    action.mockResolvedValue({ path: 'out.html' });
    const view = render(BuiltinCommandDialog, {
      desktop,
      name: 'export',
      args: 'out.html',
      onclose: vi.fn(),
    });
    await waitFor(() =>
      expect(view.getByRole('button', { name: '执行' })).toBeEnabled(),
    );
    expect(action).not.toHaveBeenCalled();
    await fireEvent.click(view.getByRole('button', { name: '执行' }));
    await waitFor(() =>
      expect(view.getByText('已导出：out.html')).toBeInTheDocument(),
    );
    expect(action).toHaveBeenCalledWith('', {
      type: 'export',
      path: 'out.html',
    });
  });
  it('copies the authoritative last assistant text to the clipboard', async () => {
    const { desktop, action } = fixture();
    action.mockResolvedValue({ text: 'assistant answer' });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const view = render(BuiltinCommandDialog, {
      desktop,
      name: 'copy',
      args: '',
      onclose: vi.fn(),
    });
    await waitFor(() =>
      expect(view.getByText('已复制最后一条助手回复。')).toBeInTheDocument(),
    );
    expect(writeText).toHaveBeenCalledWith('assistant answer');
    expect(action).toHaveBeenCalledWith('', { type: 'last_assistant' });
  });
  it.each(['session', 'clone', 'copy', 'reload'])(
    '/%s surfaces failure and permits closing without a stuck busy state',
    async (name) => {
      const { desktop, action } = fixture();
      action.mockRejectedValue(new Error('command failed'));
      vi.spyOn(desktop, 'syncState').mockResolvedValue();
      vi.spyOn(desktop, 'refreshMetadata').mockResolvedValue();
      const close = vi.fn();
      const view = render(BuiltinCommandDialog, {
        desktop,
        name,
        args: '',
        onclose: close,
      });
      await waitFor(() =>
        expect(view.getByRole('alert')).toHaveTextContent('command failed'),
      );
      await fireEvent.click(view.getByRole('button', { name: '关闭' }));
      expect(close).toHaveBeenCalledOnce();
    },
  );
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
