/** 验证运行时编号重用时的所有权，以及缓存消息跨重连的句柄稳定性。 */
import { describe, expect, it } from 'vitest';
import type { Message } from '../types';
import { SessionContent } from './session-content';
const message: Message = {
  id: 'entry-1',
  role: 'toolResult',
  text: '结果',
  thinking: '',
  contentRef: 'body-1',
  status: 'done',
  name: 'edit',
  tool: {
    callId: 'call-1',
    name: 'edit',
    argsRef: 'body-2',
    writeRef: 'body-3',
    diffRef: 'body-4',
  },
  images: [{ id: 'image-1', mimeType: 'image/png', contentRef: 'body-5' }],
};
describe('runtime-owned content references', () => {
  it('keeps stable UI handles while rebinding every content kind to the new runtime', () => {
    const cache = new SessionContent();
    const old = cache.bind(message, 'old');
    expect(() => cache.resolve(old.contentRef!, 'new')).toThrow('引用尚未恢复');
    const next = cache.bind(
      {
        ...message,
        contentRef: 'body-6',
        tool: {
          ...message.tool!,
          argsRef: 'body-7',
          writeRef: 'body-8',
          diffRef: 'body-9',
        },
        images: [{ ...message.images![0], contentRef: 'body-10' }],
      },
      'new',
      old,
    );
    expect(next).toEqual(old);
    cache.retain([next]);
    for (const [handle, raw] of [
      [old.contentRef!, 'body-6'],
      [old.tool!.argsRef!, 'body-7'],
      [old.tool!.writeRef!, 'body-8'],
      [old.tool!.diffRef!, 'body-9'],
      [old.images![0].contentRef!, 'body-10'],
    ])
      expect(cache.resolve(handle, 'new')).toBe(raw);
    expect(() => cache.resolve(old.contentRef!, 'old')).toThrow();
  });
  it('owns nested skill references and rebinds them across reconnects without losing the wrapper', () => {
    const cache = new SessionContent();
    const skillMessage: Message = {
      ...message,
      role: 'user',
      tool: null,
      images: [],
      textParts: [
        {
          kind: 'skill',
          id: 'skill',
          text: '',
          chars: 1000,
          contentRef: 'wrapper-1',
          truncated: true,
          skill: {
            name: 'ego-browser',
            location: '/skills/SKILL.md',
            text: '',
            contentRef: 'instructions-1',
            truncated: true,
          },
        },
      ],
    };
    const old = cache.bind(skillMessage, 'old');
    const handle = old.textParts![0].skill!.contentRef!;
    expect(cache.resolve(handle, 'old')).toBe('instructions-1');
    expect(() => cache.resolve(handle, 'new')).toThrow('引用尚未恢复');
    cache.retain([old]);
    expect(cache.resolve(handle, 'old')).toBe('instructions-1');
    const next = cache.bind(
      {
        ...skillMessage,
        contentRef: 'body-9',
        textParts: [
          {
            ...skillMessage.textParts![0],
            contentRef: 'wrapper-2',
            skill: {
              ...skillMessage.textParts![0].skill!,
              contentRef: 'instructions-2',
            },
          },
        ],
      },
      'new',
      old,
    );
    expect(next.textParts![0].skill!.contentRef).toBe(handle);
    expect(next.textParts![0].contentRef).toBe(old.textParts![0].contentRef);
    cache.retain([next]);
    expect(cache.resolve(handle, 'new')).toBe('instructions-2');
    expect(cache.resolve(next.textParts![0].contentRef!, 'new')).toBe(
      'wrapper-2',
    );
    expect(() => cache.resolve(handle, 'old')).toThrow();
    const changed = cache.bind(
      {
        ...skillMessage,
        textParts: [
          {
            ...skillMessage.textParts![0],
            skill: { ...skillMessage.textParts![0].skill!, name: 'changed' },
          },
        ],
      },
      'third',
      next,
    );
    cache.retain([changed]);
    expect(() => cache.resolve(handle, 'third')).toThrow();
    expect(
      cache.resolve(changed.textParts![0].skill!.contentRef!, 'third'),
    ).toBe('instructions-1');
    cache.retain([]);
    expect(() =>
      cache.resolve(changed.textParts![0].skill!.contentRef!, 'third'),
    ).toThrow();
  });
  it('never treats reused body numbers as the same content after a history change', () => {
    const cache = new SessionContent();
    const old = cache.bind(message, 'old');
    const next = cache.bind({ ...message, text: '新的结果' }, 'new', old);
    expect(next.contentRef).not.toBe(old.contentRef);
    cache.retain([next]);
    expect(() => cache.resolve(old.contentRef!, 'new')).toThrow();
    expect(cache.resolve(next.contentRef!, 'new')).toBe('body-1');
    cache.clear();
    expect(() => cache.resolve(next.contentRef!, 'new')).toThrow();
  });
  it('preserves an already loaded full body when the restored preview matches', () => {
    const cache = new SessionContent();
    const old = cache.bind(
      { ...message, text: '完整正文内容', truncated: false },
      'old',
    );
    const next = cache.bind(
      { ...message, text: '完整正文', truncated: true },
      'new',
      old,
    );
    expect(next.text).toBe('完整正文内容');
    expect(next.truncated).toBe(false);
    expect(next.contentRef).toBe(old.contentRef);
  });
});
