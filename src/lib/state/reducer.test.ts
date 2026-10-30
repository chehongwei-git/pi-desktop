/** reducer 场景测试：验证协议权威性、工具关联及输入法语义，不镜像实现细节。 */
import { describe, it, expect } from 'vitest';
import {
  reduceEvents,
  shouldSend,
  dateGroup,
  type Transcript,
} from './reducer';
import type { Message } from '../types';
/** 与 Rust 序列化契约一致的基础消息夹具。 */
function message(id: string, text = '', status = 'streaming'): Message {
  return {
    id,
    role: 'assistant',
    text,
    thinking: '',
    contentRef: null,
    status,
    name: null,
  };
}
describe('conversation projection', () => {
  it('final authoritative message replaces accumulated deltas without duplicates', () => {
    const state: Transcript = { messages: [], run: 'idle' };
    reduceEvents(state, [
      { type: 'message', message: message('a') },
      { type: 'delta', id: 'a', field: 'text', delta: 'partial' },
      { type: 'message', message: message('a', 'authoritative', 'done') },
    ]);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].text).toBe('authoritative');
  });
  it('replaces queued steering one at a time with authoritative user messages without duplicate rows', () => {
    const pending = (id: string): Message => ({
      ...message(id, 'same guidance', 'done'),
      role: 'user',
      delivery: { mode: 'steer', state: 'queued' },
    });
    const state: Transcript = {
      messages: [pending('p1'), pending('p2')],
      run: 'running',
    };
    const final = {
      ...message('user1', 'same guidance', 'done'),
      role: 'user',
    };
    reduceEvents(state, [
      { type: 'message', message: final },
      { type: 'message', message: final },
    ]);
    expect(state.messages).toHaveLength(2);
    expect(state.messages[0].delivery).toBeUndefined();
    expect(state.messages[1].delivery?.state).toBe('queued');
    reduceEvents(state, [
      { type: 'message', message: { ...final, id: 'user2' } },
    ]);
    expect(state.messages.map((message) => message.id)).toEqual([
      'user1',
      'user2',
    ]);
    expect(state.messages.some((message) => message.delivery)).toBe(false);
  });
  it('settled idle state is distinct from an accepted prompt', () => {
    const state: Transcript = { messages: [], run: 'running' };
    reduceEvents(state, [{ type: 'run', state: 'retrying' }]);
    expect(state.run).toBe('retrying');
    reduceEvents(state, [{ type: 'run', state: 'idle' }]);
    expect(state.run).toBe('idle');
  });
  it('IME enter, legacy 229 and Shift+Enter never send', () => {
    const enter = {
      key: 'Enter',
      shiftKey: false,
      isComposing: false,
      keyCode: 13,
    };
    expect(shouldSend(enter, false)).toBe(true);
    expect(shouldSend({ ...enter, isComposing: true }, false)).toBe(false);
    expect(shouldSend({ ...enter, keyCode: 229 }, false)).toBe(false);
    expect(shouldSend({ ...enter, shiftKey: true }, false)).toBe(false);
  });
  it('groups local dates across the previous day', () => {
    const now = new Date(2026, 9, 29, 12);
    expect(dateGroup(new Date(2026, 9, 28, 23).getTime(), now)).toBe('昨天');
  });
});
