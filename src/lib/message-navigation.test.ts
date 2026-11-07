import { describe, expect, it } from 'vitest';
import { messageSummary, navigationMessages } from './message-navigation';
import type { Message } from './types';
const message = (id: string, extra: Partial<Message> = {}): Message => ({
  id,
  role: 'user',
  text: '重复问题',
  thinking: '',
  contentRef: null,
  status: 'done',
  name: null,
  ...extra,
});

describe('我的消息目录', () => {
  it('按身份去重、保留重复文本并使用最新权威消息', () => {
    const latest = message('2', { text: '已更新' });
    expect(
      navigationMessages([message('1'), message('2')], [latest, message('3')]),
    ).toEqual([message('1'), latest, message('3')]);
  });
  it('只收录已确认用户消息，包括已排队引导', () => {
    const queued = message('q', {
      delivery: { mode: 'steer', state: 'queued' },
    });
    expect(
      navigationMessages(
        [],
        [
          message('a', { role: 'assistant' }),
          message('s', { delivery: { mode: 'followUp', state: 'sending' } }),
          queued,
        ],
      ),
    ).toEqual([queued]);
  });
  it('摘要压缩空白，按 Unicode 字符截断，不发起全文读取', () => {
    expect(messageSummary(message('1', { text: '你好\r\n   世界' }))).toBe(
      '你好 世界',
    );
    expect(
      Array.from(messageSummary(message('2', { text: '😀'.repeat(200) }))),
    ).toHaveLength(160);
  });
  it('兼容图片、长粘贴和三平台文件名', () => {
    expect(
      messageSummary(
        message('i', {
          text: '',
          images: [{ id: 'i', mimeType: 'image/png' }],
        }),
      ),
    ).toBe('图片 · 1 张');
    for (const path of ['C:\\work\\test.ts', '/work/test.ts']) {
      expect(
        messageSummary(
          message('f', {
            text: '文件引用协议',
            textParts: [
              {
                id: 'f',
                kind: 'files',
                text: '',
                chars: 0,
                contentRef: null,
                truncated: false,
                files: [{ id: 'f', path }],
              },
            ],
          }),
        ),
      ).toBe('文件 · test.ts');
    }
    expect(
      messageSummary(
        message('p', {
          text: '',
          textParts: [
            {
              id: 'p',
              kind: 'paste',
              text: '设计\n方案',
              chars: 5,
              contentRef: null,
              truncated: false,
            },
          ],
        }),
      ),
    ).toBe('粘贴文本 · 设计 方案');
    expect(messageSummary(message('empty', { text: '' }))).toBe('无文字消息');
  });
});
