import { describe, expect, it } from 'vitest';
import { processDuration, processRows } from './process-groups';
import type { Message, ProcessInfo } from './types';
const info: ProcessInfo = {
  id: 'turn',
  startedAt: 1000,
  endedAt: 24000,
  state: 'done',
};
function message(
  id: string,
  role: string,
  extra: Partial<Message> = {},
): Message {
  return {
    id,
    role,
    text: id,
    thinking: '',
    contentRef: null,
    status: 'done',
    name: null,
    ...extra,
  };
}
describe('统一处理过程', () => {
  it('keeps all commentary visible and folds only tools and thinking between replies', () => {
    const rows = processRows([
      message('progress', 'assistant', {
        presentation: 'process',
        process: info,
      }),
      message('a', 'toolResult', { process: info }),
      message('steer', 'user'),
      message('b', 'toolResult', { process: info }),
      message('answer', 'assistant', {
        presentation: 'answer',
        thinking: '分析',
        process: info,
      }),
    ]);
    expect(rows.map((row) => row.kind)).toEqual([
      'message',
      'process',
      'message',
      'process',
      'message',
    ]);
    const group = rows[1];
    if (group.kind !== 'process') throw Error('missing group');
    expect(group.messages.map((m) => m.id)).toEqual(['a']);
    const later = rows[3];
    if (later.kind !== 'process') throw Error('missing group');
    expect(later.messages.map((m) => m.id)).toEqual(['b', 'answer']);
    expect(later.messages.at(-1)?.text).toBe('');
    expect(rows.at(-1)).toMatchObject({
      message: { text: 'answer', thinking: '' },
    });
    expect(processDuration(group.info, 999999)).toBe('23 秒');
  });
  it('does not create a group for a direct answer and retains a stable id across pagination', () => {
    expect(processRows([message('answer', 'assistant')])[0].kind).toBe(
      'message',
    );
    const tail = message('b', 'toolResult', { process: info });
    expect(processRows([tail])[0].id).toBe(
      processRows([message('a', 'toolResult', { process: info }), tail])[0].id,
    );
  });
  it('uses tool association for legacy messages and omits unavailable timing', () => {
    const rows = processRows([
      message('progress', 'assistant'),
      message('tool', 'toolResult'),
      message('answer', 'assistant'),
    ]);
    expect(rows.map((r) => r.kind)).toEqual(['message', 'process', 'message']);
    expect(processDuration(undefined, 5000)).toBe('');
    expect(processDuration({ id: 'old', state: 'stopped' }, 5000)).toBe('');
  });
  it('renders streaming text despite old process classification and splits groups at every reply', () => {
    const rows = processRows([
      message('thinking', 'assistant', {
        text: '',
        thinking: '思考',
        status: 'streaming',
        process: info,
      }),
      message('reply', 'assistant', {
        presentation: 'process',
        status: 'streaming',
        process: info,
      }),
      message('tool', 'toolResult', { process: { ...info, id: 'next' } }),
      message('reply2', 'assistant', {
        thinking: '更多分析',
        process: { ...info, id: 'next' },
      }),
    ]);
    expect(rows.map((r) => r.kind)).toEqual([
      'process',
      'message',
      'process',
      'message',
    ]);
    expect(rows[1]).toMatchObject({
      message: { text: 'reply', status: 'streaming' },
    });
    expect(rows[0].id).not.toBe(rows[2].id);
    const empty = processRows([
      message('empty', 'assistant', { text: '', status: 'streaming' }),
    ]);
    expect(empty).toEqual([]);
  });
  it('merges tools and thinking across whitespace-only bodies even with content references', () => {
    const rows = processRows([
      message('a', 'toolResult', { process: info }),
      message('blank', 'assistant', {
        text: ' \r\n\t',
        contentRef: 'blank-body',
        process: info,
      }),
      message('thinking', 'assistant', {
        text: '\n',
        thinking: '继续检查',
        contentRef: 'thinking-body',
        process: info,
      }),
      message('b', 'toolResult', { process: info }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'process',
      id: 'process-turn',
      messages: [
        { id: 'a' },
        { id: 'thinking', text: '', contentRef: null },
        { id: 'b' },
      ],
    });
  });
  it.each([
    { text: '', contentRef: 'evicted-body' },
    { text: ' \n', contentRef: 'truncated-body', truncated: true },
    { text: '真实正文', contentRef: 'body' },
    { text: '', images: [{ id: 'image', mimeType: 'image/png' }] },
  ])('retains real or not yet fully loaded body boundaries: %j', (body) => {
    const rows = processRows([
      message('a', 'toolResult', { process: info }),
      message('body', 'assistant', body),
      message('b', 'toolResult', { process: info }),
    ]);
    expect(rows.map((row) => row.kind)).toEqual([
      'process',
      'message',
      'process',
    ]);
    expect(rows[0].id).not.toBe(rows[2].id);
  });
  it('freezes while waiting, resumes without a jump and preserves final active duration', () => {
    const paused: ProcessInfo = {
      id: 'waiting',
      startedAt: 1000,
      state: 'running',
      pausedAt: 6000,
      pausedMs: 2000,
    };
    expect(processDuration(paused, 10000)).toBe('3 秒');
    expect(processDuration(paused, 90000)).toBe('3 秒');
    const resumed = { ...paused, pausedAt: undefined, pausedMs: 16000 };
    expect(processDuration(resumed, 20000)).toBe('3 秒');
    expect(processDuration(resumed, 23000)).toBe('6 秒');
    expect(
      processDuration({ ...resumed, state: 'stopped', endedAt: 23000 }, 90000),
    ).toBe('6 秒');
  });
  it('updates only running elapsed time, clamps rollback and formats minutes and hours', () => {
    expect(
      processDuration({ ...info, endedAt: undefined, state: 'running' }, 13000),
    ).toBe('12 秒');
    expect(processDuration({ ...info, endedAt: 500 }, 13000)).toBe('<1 秒');
    expect(processDuration({ ...info, endedAt: 84000 }, 0)).toBe('1 分 23 秒');
    expect(processDuration({ ...info, endedAt: 3721000 }, 0)).toBe(
      '1 小时 2 分',
    );
  });
});
