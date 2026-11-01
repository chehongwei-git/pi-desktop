/** 提示词历史复用会话投影，验证分页与正文读取不修改对话列表。 */
import { describe, expect, it, vi } from 'vitest';
import { Desktop } from './desktop.svelte';
import { bridge } from '../client';
import type { Message } from '../types';
const message: Message = {
  id: 'user',
  role: 'user',
  text: '预览',
  thinking: '',
  contentRef: null,
  status: 'done',
  name: null,
};
describe('prompt history', () => {
  it('仅包含正式用户消息及成功排队消息，新对话不泄漏后台历史', async () => {
    const desktop = new Desktop();
    desktop.messages = [
      message,
      { ...message, id: 'assistant', role: 'assistant' },
      {
        ...message,
        id: 'sending',
        delivery: { mode: 'steer', state: 'sending' },
      },
      {
        ...message,
        id: 'queued',
        delivery: { mode: 'followUp', state: 'queued' },
      },
    ];
    expect((await desktop.promptHistory()).messages.map((m) => m.id)).toEqual([
      'user',
      'queued',
    ]);
    desktop.newChatProject = 'new';
    expect((await desktop.promptHistory()).messages).toEqual([]);
  });
  it('独立分页，不改变正文或游标，拒绝迟到页面及无进展游标', async () => {
    const action = vi
      .fn()
      .mockResolvedValue({ messages: [message], before: 0, hasMore: false });
    const desktop = new Desktop({ ...bridge, action });
    desktop.before = 50;
    desktop.hasMore = true;
    expect((await desktop.promptHistory(50)).messages).toHaveLength(1);
    expect(desktop.messages).toEqual([]);
    expect(desktop.before).toBe(50);
    action.mockResolvedValueOnce({ messages: [], before: 50, hasMore: true });
    await expect(desktop.promptHistory(50)).rejects.toThrow('游标未前进');
    let release!: (page: unknown) => void;
    action.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = desktop.promptHistory(50);
    desktop.snapshot.sessionFile = 'another';
    release({ messages: [message], before: 0, hasMore: false });
    await expect(pending).rejects.toThrow('会话已切换');
  });
  it('按宿主偏移读取完整 Unicode 正文，并拒绝停滞分块', async () => {
    const content = vi
      .fn()
      .mockResolvedValueOnce({ text: '中文🙂', next: 10, done: false })
      .mockResolvedValueOnce({ text: '\n完整正文', next: 30, done: true });
    const desktop = new Desktop({ ...bridge, content });
    desktop.runtimeId = 'runtime';
    const long = { ...message, contentRef: 'body', truncated: true };
    expect(await desktop.promptText(long)).toBe('中文🙂\n完整正文');
    expect(content.mock.calls).toEqual([
      ['runtime', 'body', 0],
      ['runtime', 'body', 10],
    ]);
    content.mockResolvedValueOnce({ text: '', next: 0, done: false });
    await expect(desktop.promptText(long)).rejects.toThrow('正文读取未前进');
  });
});
