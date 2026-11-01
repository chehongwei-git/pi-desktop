import { describe, expect, it } from 'vitest';
import { conversationActivity } from './conversation-activity';
import type { Message } from './types';

function message(
  role: string,
  status: string,
  extra: Partial<Message> = {},
): Message {
  return {
    id: 'm',
    role,
    status,
    text: '',
    thinking: '',
    contentRef: null,
    name: null,
    ...extra,
  };
}

describe('conversation activity', () => {
  it('prioritizes stop, waiting, retry and compaction over message activity', () => {
    const messages = [message('assistant', 'streaming', { text: '回复' })];
    expect(conversationActivity('idle', messages, true)).toBeNull();
    expect(conversationActivity('aborting', messages, true)).toMatchObject({
      label: '正在停止任务',
      stopping: true,
    });
    expect(conversationActivity('retrying', messages, true)).toMatchObject({
      label: '等待你的操作',
      paused: true,
    });
    expect(conversationActivity('retrying', messages)?.label).toBe('正在重试');
    expect(conversationActivity('compacting', messages)?.label).toBe(
      '正在压缩上下文',
    );
  });

  it('replaces dots with the visible reply cursor and resumes after the message ends', () => {
    expect(conversationActivity('running', [])?.label).toBe('Pi 正在处理');
    expect(
      conversationActivity('running', [
        message('assistant', 'streaming', { thinking: '分析' }),
      ])?.label,
    ).toBe('正在思考');
    expect(
      conversationActivity('running', [
        message('assistant', 'streaming', { text: '回答' }),
      ]),
    ).toBeNull();
    expect(
      conversationActivity('running', [
        message('assistant', 'done', { text: '说明' }),
      ])?.label,
    ).toBe('Pi 正在处理');
  });

  it('counts parallel tools without treating queued messages as a new turn', () => {
    const messages = [
      message('toolResult', 'running'),
      message('toolResult', 'running'),
      message('toolResult', 'done'),
      message('user', 'done', { delivery: { mode: 'steer', state: 'queued' } }),
    ];
    expect(conversationActivity('running', messages)?.label).toBe(
      '正在执行工具 · 2 项进行中',
    );
    messages.push(message('user', 'done'));
    expect(conversationActivity('running', messages)?.label).toBe(
      'Pi 正在处理',
    );
    messages.push(message('toolResult', 'running'));
    expect(conversationActivity('running', messages)?.label).toBe(
      '正在执行工具',
    );
  });
});
