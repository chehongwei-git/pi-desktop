import { expect, it, vi } from 'vitest';
import { Desktop } from './desktop.svelte';
import { bridge } from '../client';
import type { Message } from '../types';
const message: Message = {
  id: 'live-1',
  role: 'user',
  text: '原文',
  thinking: '',
  contentRef: null,
  name: null,
  status: 'done',
};
function fixture() {
  let path = 'original.jsonl';
  const action = vi.fn(async (_runtime: string, input: { type: string }) => {
    if (input.type === 'session_tree')
      return {
        leafId: 'u',
        nodes: [{ id: 'u', parentId: null, label: 'user' }],
      };
    if (input.type === 'fork') {
      path = 'branch.jsonl';
      return { cancelled: false };
    }
    if (input.type === 'state') return { sessionFile: path };
    if (input.type === 'history')
      return { messages: [], before: 0, hasMore: false };
    if (input.type === 'changes') return [];
    return {};
  });
  const desktop = new Desktop({
    ...bridge,
    action: action as typeof bridge.action,
    events: vi.fn(async () => ({ runtimeId: 'r', sequence: 0, events: [] })),
    sessions: vi.fn(async () => []),
  });
  desktop.runtimeId = 'r';
  desktop.connection = 'ready';
  desktop.snapshot = { sessionFile: path };
  desktop.messages = [message];
  desktop.draft = '底部草稿';
  return { desktop, action };
}
it('prepares only on send, forks before prompting, and preserves bottom draft', async () => {
  const { desktop, action } = fixture();
  await desktop.editMessage(message);
  expect(action).not.toHaveBeenCalled();
  desktop.messageEdit!.draft.text = '修改';
  await desktop.resendMessage();
  const calls = action.mock.calls.map(([, input]) => input.type);
  expect(calls.indexOf('fork')).toBeLessThan(calls.indexOf('prompt'));
  expect(action).toHaveBeenCalledWith(
    'r',
    expect.objectContaining({ type: 'fork', entryId: 'u' }),
  );
  expect(action).toHaveBeenCalledWith(
    'r',
    expect.objectContaining({ type: 'prompt', message: '修改' }),
  );
  expect(desktop.messageEdit).toBeNull();
  expect(desktop.draft).toBe('底部草稿');
});
it('blocks running and slash-command submissions without creating a branch', async () => {
  const { desktop, action } = fixture();
  await desktop.editMessage(message);
  desktop.run = 'running';
  await desktop.resendMessage();
  expect(action).not.toHaveBeenCalled();
  desktop.run = 'idle';
  desktop.messageEdit!.draft.text = '/quit';
  await desktop.resendMessage();
  expect(action).not.toHaveBeenCalled();
  expect(desktop.messageEdit!.error).toContain('斜杠');
});
it('retains edit on extension cancellation and never blindly retries unknown prompt results', async () => {
  const { desktop, action } = fixture();
  await desktop.editMessage(message);
  action
    .mockImplementationOnce(async () => ({
      leafId: 'u',
      nodes: [{ id: 'u', parentId: null, label: 'user' }],
    }))
    .mockImplementationOnce(async () => ({ cancelled: true }));
  await desktop.resendMessage();
  expect(desktop.messageEdit!.error).toContain('取消');
  const original = action.getMockImplementation()!;
  action.mockImplementation(async (runtime, input) => {
    if (input.type === 'prompt') throw new Error('TIMEOUT');
    return original(runtime, input);
  });
  await desktop.resendMessage();
  expect(desktop.messageEdit!.uncertain).toBe(true);
  const count = action.mock.calls.length;
  await desktop.resendMessage();
  expect(action).toHaveBeenCalledTimes(count);
  expect(desktop.messageEdit!.draft.text).toBe('原文');
});
it('retries explicit rejection on the prepared branch without forking twice', async () => {
  const { desktop, action } = fixture();
  await desktop.editMessage(message);
  const original = action.getMockImplementation()!;
  let rejected = false;
  action.mockImplementation(async (runtime, input) => {
    if (input.type === 'prompt' && !rejected) {
      rejected = true;
      throw { code: 'PI_COMMAND', message: '拒绝' };
    }
    return original(runtime, input);
  });
  await desktop.resendMessage();
  expect(desktop.messageEdit!.branch).toBe('branch.jsonl');
  expect(desktop.messageEdit!.uncertain).not.toBe(true);
  await desktop.resendMessage();
  expect(
    action.mock.calls.filter(([, input]) => input.type === 'fork'),
  ).toHaveLength(1);
  expect(desktop.messageEdit).toBeNull();
});
