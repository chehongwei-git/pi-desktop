/** 门面测试使用可替换 IPC 端口，验证失败保留草稿、取消切换和一次性扩展响应。 */
import { describe, it, expect, vi } from 'vitest';
import { Desktop } from './desktop.svelte';
import { bridge, type Bridge } from '../client';
/** 只替换 action；其余桥接函数不应在这些独立场景中被触发。 */
function fixture(action: Bridge['action']) {
  return new Desktop({ ...bridge, action });
}
describe('desktop business behavior', () => {
  it('keeps draft on rejection and never retries automatically', async () => {
    const action = vi
      .fn()
      .mockRejectedValue({ code: 'TIMEOUT', message: 'unknown result' });
    const desktop = fixture(action);
    desktop.connection = 'ready';
    desktop.runtimeId = 'r';
    desktop.draft = 'keep me';
    await expect(desktop.send()).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(desktop.draft).toBe('keep me');
    expect(action).toHaveBeenCalledTimes(1);
  });
  it('does not clear the visible transcript on cancelled session switch', async () => {
    const action = vi.fn().mockResolvedValue({ cancelled: true });
    const desktop = fixture(action);
    desktop.project = 'project';
    desktop.snapshot = { sessionFile: 'original' };
    desktop.messages = [
      {
        id: 'a',
        role: 'user',
        text: 'hello',
        thinking: '',
        contentRef: null,
        status: 'done',
        name: null,
      },
    ];
    await desktop.switchSession('other');
    expect(desktop.snapshot.sessionFile).toBe('original');
    expect(desktop.messages[0].text).toBe('hello');
  });
  it('drains reset before committing restored history', async () => {
    const message = {
      id: 'restored',
      role: 'assistant',
      text: 'preserved',
      thinking: '',
      contentRef: null,
      status: 'done',
      name: null,
    };
    const action: Bridge['action'] = async <T>(
      _: string,
      command: Parameters<Bridge['action']>[1],
    ) => {
      const result =
        command.type === 'history'
          ? { messages: [message], before: 0, hasMore: false }
          : command.type === 'state'
            ? { sessionFile: 'new' }
            : { cancelled: false };
      return result as T;
    };
    const events = vi
      .fn()
      .mockResolvedValueOnce({
        runtimeId: 'r',
        sequence: 1,
        events: [{ type: 'reset' }],
      })
      .mockResolvedValue({ runtimeId: 'r', sequence: 1, events: [] });
    const desktop = new Desktop({
      ...bridge,
      action,
      events,
      sessions: async () => [],
    });
    desktop.project = 'project';
    desktop.runtimeId = 'r';
    desktop.connection = 'ready';
    await desktop.switchSession('new');
    expect(events).toHaveBeenCalledTimes(2);
    expect(desktop.messages[0].text).toBe('preserved');
  });
  it('submits a dialog response only once across cancellation races', async () => {
    const action = vi.fn().mockResolvedValue(null);
    const desktop = fixture(action);
    const request = {
      type: 'extension_ui_request',
      id: 'request-1',
      method: 'confirm',
    };
    desktop.extensions = [request];
    await Promise.all([
      desktop.respond(request, { cancelled: true }),
      desktop.respond(request, { confirmed: true }),
    ]);
    expect(action).toHaveBeenCalledOnce();
  });
});
