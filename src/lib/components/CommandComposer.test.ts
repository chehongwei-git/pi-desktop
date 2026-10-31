/** 内联命令通过真实键盘事件验证层级、搜索、IME 和草稿；不创建 Pi 进程。 */
import '@testing-library/jest-dom/vitest';
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CommandComposer from './CommandComposer.svelte';
import { Desktop } from '../state/desktop.svelte';
import { bridge } from '../client';
afterEach(cleanup);
function fixture() {
  const action = vi.fn().mockResolvedValue({});
  const desktop = new Desktop({ ...bridge, action });
  desktop.connection = 'ready';
  desktop.draft = '/settings';
  return { desktop, action };
}
describe('inline command menus', () => {
  it('opens settings and a child menu, executes RPC and returns without sending a prompt', async () => {
    const { desktop, action } = fixture();
    const send = vi.fn();
    const view = render(CommandComposer, { desktop, onsend: send });
    await fireEvent.keyDown(view.getByRole('textbox'), { key: 'Enter' });
    expect(
      view.getByRole('listbox', { name: '/settings · Pi 设置' }),
    ).toBeInTheDocument();
    await fireEvent.keyDown(view.getByRole('textbox'), { key: 'Enter' });
    expect(
      view.getByRole('listbox', { name: 'Pi 设置 / 自动压缩' }),
    ).toBeInTheDocument();
    await fireEvent.keyDown(view.getByRole('textbox'), { key: 'Enter' });
    await waitFor(() =>
      expect(action).toHaveBeenCalledWith('', {
        type: 'set_auto_compaction',
        enabled: true,
      }),
    );
    await waitFor(() =>
      expect(
        view.getByRole('listbox', { name: '/settings · Pi 设置' }),
      ).toBeInTheDocument(),
    );
    await fireEvent.keyDown(view.getByRole('textbox'), { key: 'Escape' });
    expect(desktop.draft).toBe('/settings');
    expect(send).not.toHaveBeenCalled();
  });
  it('searches a large model list with bounded DOM and selects without changing draft during search', async () => {
    const { desktop } = fixture();
    desktop.draft = '/model';
    desktop.models = Array.from({ length: 5000 }, (_, i) => ({
      provider: 'test',
      id: `m${i}`,
      name: `Model ${i}`,
    }));
    const setModel = vi.spyOn(desktop, 'setModel').mockResolvedValue();
    const view = render(CommandComposer, { desktop, onsend: vi.fn() });
    await fireEvent.keyDown(view.getByRole('textbox'), { key: 'Enter' });
    expect(
      view.getByRole('listbox').querySelectorAll('[role="option"]').length,
    ).toBeLessThanOrEqual(40);
    await fireEvent.input(view.getByRole('textbox'), {
      target: { value: 'm4999' },
    });
    expect(desktop.draft).toBe('/model');
    await fireEvent.compositionStart(view.getByRole('textbox'));
    await fireEvent.keyDown(view.getByRole('textbox'), { key: 'Enter' });
    expect(setModel).not.toHaveBeenCalled();
    await fireEvent.compositionEnd(view.getByRole('textbox'));
    await fireEvent.keyDown(view.getByRole('textbox'), { key: 'Enter' });
    await waitFor(() => expect(setModel).toHaveBeenCalledWith('test/m4999'));
  });
  it('hides bridge-dependent commands when the bridge is missing', async () => {
    const { desktop } = fixture();
    desktop.draft = '/';
    const view = render(CommandComposer, { desktop, onsend: vi.fn() });
    expect(
      view.queryByRole('option', { name: /\/reload/ }),
    ).not.toBeInTheDocument();
    expect(
      view.queryByRole('option', { name: /\/tree/ }),
    ).not.toBeInTheDocument();
    expect(
      view.queryByRole('option', { name: /\/login/ }),
    ).not.toBeInTheDocument();
  });
  it('selects a tree node and asks how to navigate before calling the bridge', async () => {
    const { desktop, action } = fixture();
    desktop.draft = '/tree';
    desktop.commands = [
      { name: 'pi-desktop-navigate-v1', source: 'extension' },
    ];
    action.mockResolvedValue({
      nodes: [{ id: 'n1', parentId: null, label: 'user', text: 'hello' }],
    });
    const refresh = vi
      .spyOn(desktop, 'refreshCommandSession')
      .mockResolvedValue();
    const view = render(CommandComposer, { desktop, onsend: vi.fn() });
    await fireEvent.keyDown(view.getByRole('textbox'), { key: 'Enter' });
    await waitFor(() =>
      expect(view.getByRole('option', { name: /n1/ })).toBeEnabled(),
    );
    await fireEvent.keyDown(view.getByRole('textbox'), { key: 'Enter' });
    expect(
      view.getByRole('option', { name: /生成摘要后切换/ }),
    ).toBeInTheDocument();
    await fireEvent.keyDown(view.getByRole('textbox'), { key: 'Enter' });
    await waitFor(() =>
      expect(action).toHaveBeenCalledWith('', {
        type: 'navigate_tree',
        entryId: 'n1',
        summarize: false,
      }),
    );
    expect(refresh).toHaveBeenCalledOnce();
  });
  it.each(['tree', 'fork'] as const)(
    'Esc cancels pending /%s loading and ignores late results',
    async (command) => {
      const { desktop, action } = fixture();
      desktop.draft = `/${command}`;
      desktop.commands = [
        { name: 'pi-desktop-navigate-v1', source: 'extension' },
      ];
      let finish!: (value: unknown) => void;
      action.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const send = vi.fn();
      const view = render(CommandComposer, { desktop, onsend: send });
      await fireEvent.keyDown(view.getByRole('textbox'), { key: 'Enter' });
      await fireEvent.keyDown(view.getByRole('textbox'), { key: 'Escape' });
      const input = view.getByRole('textbox', { name: '消息输入' });
      expect(input).toHaveFocus();
      expect(view.queryByRole('listbox')).not.toBeInTheDocument();
      await fireEvent.input(input, { target: { value: '继续工作' } });
      await fireEvent.keyDown(input, { key: 'Enter' });
      expect(send).toHaveBeenCalledOnce();
      finish(command === 'tree' ? { nodes: [] } : { messages: [] });
      await waitFor(() =>
        expect(view.queryByRole('listbox')).not.toBeInTheDocument(),
      );
      expect(input).toHaveValue('继续工作');
    },
  );
  it.each(['tree', 'fork'] as const)(
    'failed /%s closes with Esc from the return button and remains editable',
    async (command) => {
      const { desktop, action } = fixture();
      desktop.draft = `/${command}`;
      desktop.commands = [
        { name: 'pi-desktop-navigate-v1', source: 'extension' },
      ];
      action.mockRejectedValue(new Error('load failed'));
      const view = render(CommandComposer, { desktop, onsend: vi.fn() });
      await fireEvent.keyDown(view.getByRole('textbox'), { key: 'Enter' });
      await waitFor(() =>
        expect(view.getByRole('alert')).toHaveTextContent('load failed'),
      );
      const back = view.getByRole('button', { name: '← 返回' });
      back.focus();
      await fireEvent.keyDown(back, { key: 'Escape' });
      await waitFor(() =>
        expect(view.getByRole('textbox', { name: '消息输入' })).toHaveFocus(),
      );
      expect(view.queryByRole('listbox')).not.toBeInTheDocument();
    },
  );
  it('keeps the draft editable after a fatal protocol error and return', async () => {
    const { desktop, action } = fixture();
    desktop.draft = '/tree';
    desktop.commands = [
      { name: 'pi-desktop-navigate-v1', source: 'extension' },
    ];
    action.mockImplementation(async () => {
      desktop.connection = 'failed';
      throw new Error('Pi stdout 不是有效 JSONL');
    });
    const send = vi.fn();
    const view = render(CommandComposer, { desktop, onsend: send });
    await fireEvent.keyDown(view.getByRole('textbox'), { key: 'Enter' });
    await waitFor(() =>
      expect(view.getByRole('alert')).toHaveTextContent('不是有效 JSONL'),
    );
    await fireEvent.click(view.getByRole('button', { name: '← 返回' }));
    const input = view.getByRole('textbox', { name: '消息输入' });
    expect(input).toBeEnabled();
    expect(input).toHaveFocus();
    await fireEvent.input(input, { target: { value: '保留新的草稿' } });
    expect(desktop.draft).toBe('保留新的草稿');
    await fireEvent.keyDown(input, { key: 'Enter' });
    expect(send).not.toHaveBeenCalled();
    expect(view.getByRole('button', { name: '发送消息' })).toBeDisabled();
  });
  it('renders a long flat session tree without recursive traversal or unbounded DOM', async () => {
    const { desktop, action } = fixture();
    desktop.draft = '/tree';
    desktop.commands = [
      { name: 'pi-desktop-navigate-v1', source: 'extension' },
    ];
    action.mockResolvedValue({
      nodes: Array.from({ length: 2000 }, (_, i) => ({
        id: `node-${i}`,
        parentId: i ? `node-${i - 1}` : null,
        label: 'user',
        text: `message ${i}`,
      })),
    });
    const view = render(CommandComposer, { desktop, onsend: vi.fn() });
    await fireEvent.keyDown(view.getByRole('textbox'), { key: 'Enter' });
    await waitFor(() =>
      expect(
        view.getByRole('listbox').querySelectorAll('[role="option"]'),
      ).toHaveLength(40),
    );
    await fireEvent.input(view.getByRole('textbox'), {
      target: { value: 'node-1999' },
    });
    expect(view.getByRole('option', { name: /node-1999/ })).toBeEnabled();
  });
  it('sets thinking level through the inline menu', async () => {
    const { desktop, action } = fixture();
    desktop.draft = '/thinking';
    desktop.levels = ['off', 'high'];
    vi.spyOn(desktop, 'syncState').mockResolvedValue();
    const view = render(CommandComposer, { desktop, onsend: vi.fn() });
    await fireEvent.keyDown(view.getByRole('textbox'), { key: 'Enter' });
    await fireEvent.click(
      within(view.getByRole('listbox')).getByRole('option', { name: 'high' }),
    );
    await waitFor(() =>
      expect(action).toHaveBeenCalledWith('', {
        type: 'set_thinking',
        level: 'high',
      }),
    );
    await waitFor(() => expect(desktop.draft).toBe(''));
  });
  it('resumes a selected session through the session transaction', async () => {
    const { desktop } = fixture();
    desktop.draft = '/resume';
    desktop.snapshot.sessionFile = 'old';
    desktop.sessions = [
      { path: 'next', name: 'Next', cwd: 'project' },
    ] as typeof desktop.sessions;
    const switchSession = vi
      .spyOn(desktop, 'switchSession')
      .mockImplementation(async () => {
        desktop.snapshot.sessionFile = 'next';
      });
    const view = render(CommandComposer, { desktop, onsend: vi.fn() });
    await fireEvent.keyDown(view.getByRole('textbox'), { key: 'Enter' });
    await fireEvent.click(view.getByRole('option', { name: /next/ }));
    expect(switchSession).toHaveBeenCalledWith('next');
  });
  it('forks from the selected user message and restores its text', async () => {
    const { desktop, action } = fixture();
    desktop.draft = '/fork';
    action
      .mockResolvedValueOnce({
        messages: [{ entryId: 'u1', text: 'original prompt' }],
      })
      .mockResolvedValueOnce({ text: 'original prompt', cancelled: false });
    vi.spyOn(desktop, 'refreshCommandSession').mockResolvedValue();
    const view = render(CommandComposer, { desktop, onsend: vi.fn() });
    await fireEvent.keyDown(view.getByRole('textbox'), { key: 'Enter' });
    await waitFor(() =>
      expect(view.getByRole('option', { name: /u1/ })).toBeEnabled(),
    );
    await fireEvent.click(view.getByRole('option', { name: /u1/ }));
    await waitFor(() => expect(desktop.draft).toBe('original prompt'));
    expect(action).toHaveBeenLastCalledWith('', {
      type: 'fork',
      entryId: 'u1',
    });
  });
  it.each([
    ['引导消息模式', 'set_steering_mode'],
    ['后续消息模式', 'set_follow_up_mode'],
  ])('configures %s without a prompt', async (label, type) => {
    const { desktop, action } = fixture();
    vi.spyOn(desktop, 'syncState').mockResolvedValue();
    const view = render(CommandComposer, { desktop, onsend: vi.fn() });
    await fireEvent.keyDown(view.getByRole('textbox'), { key: 'Enter' });
    await fireEvent.click(
      view.getByRole('option', { name: new RegExp(label) }),
    );
    await fireEvent.click(view.getByRole('option', { name: '全部处理' }));
    await waitFor(() =>
      expect(action).toHaveBeenCalledWith('', { type, mode: 'all' }),
    );
  });
  it('keeps the menu and draft on failed settings changes', async () => {
    const { desktop, action } = fixture();
    action.mockRejectedValue(new Error('failed'));
    const view = render(CommandComposer, { desktop, onsend: vi.fn() });
    await fireEvent.keyDown(view.getByRole('textbox'), { key: 'Enter' });
    await fireEvent.keyDown(view.getByRole('textbox'), { key: 'Enter' });
    await fireEvent.keyDown(view.getByRole('textbox'), { key: 'Enter' });
    await waitFor(() =>
      expect(view.getByRole('alert')).toHaveTextContent('failed'),
    );
    expect(desktop.draft).toBe('/settings');
  });
});
