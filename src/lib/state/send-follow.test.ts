import { describe, expect, it, vi } from 'vitest';
import { Desktop } from './desktop.svelte';

/** 跟随信号以提交成功与会话归属为准，不能从草稿清空推断。 */
function fixture() {
  const desktop = new Desktop();
  desktop.connection = 'ready';
  desktop.snapshot = { sessionFile: 'current.jsonl' };
  desktop.draft = '继续处理';
  const action = vi.spyOn(desktop, 'action').mockResolvedValue({});
  return { desktop, action };
}

describe('send follow signal', () => {
  it('signals accepted messages but ignores empty input and local commands', async () => {
    const { desktop } = fixture();
    await desktop.send();
    expect(desktop.sentMessageRevision).toBe(1);
    await desktop.send();
    desktop.draft = '/settings';
    await desktop.send();
    expect(desktop.sentMessageRevision).toBe(1);
  });

  it('preserves reading state when submission fails', async () => {
    const { desktop, action } = fixture();
    action.mockRejectedValueOnce(new Error('send failed'));
    await expect(desktop.send()).rejects.toThrow('send failed');
    expect(desktop.sentMessageRevision).toBe(0);
    expect(desktop.draft).toBe('继续处理');
  });

  it('ignores a late submission after the visible session changes', async () => {
    const { desktop, action } = fixture();
    let release!: () => void;
    action.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const task = desktop.send();
    desktop.snapshot = { sessionFile: 'other.jsonl' };
    release();
    await task;
    expect(desktop.sentMessageRevision).toBe(0);
  });
});
