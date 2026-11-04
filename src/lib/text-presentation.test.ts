import { describe, expect, it } from 'vitest';
import {
  fullText,
  localTextParts,
  textPreview,
  textRanges,
} from './text-presentation';
import type { DraftPart } from './draft-parts';

describe('text presentation', () => {
  const parts: DraftPart[] = [
    { kind: 'text', text: '前' },
    { kind: 'paste', id: 'paste', text: '😀\r\n后' },
    { kind: 'text', text: '结尾' },
  ];
  it('only sends ranges while cards remain, with UTF-16 offsets and exact original text', () => {
    const text = parts.map((p) => p.text).join('');
    expect(textRanges(parts, text)).toEqual([
      { kind: 'text', id: 'text-0', start: 0, end: 1 },
      { kind: 'paste', id: 'paste', start: 1, end: 6 },
      { kind: 'text', id: 'text-2', start: 6, end: 8 },
    ]);
    expect(
      localTextParts(parts, text)
        ?.map((p) => p.text)
        .join(''),
    ).toBe(text);
    expect(textRanges([{ kind: 'text', text }], text)).toBeUndefined();
    expect(textRanges(parts, 'changed')).toBeUndefined();
    expect(textPreview('😀'.repeat(500))).toBe('😀'.repeat(360));
    expect(textPreview('a\r\n'.repeat(12))).toBe(Array(6).fill('a').join('\n'));
  });
  it('copies the full paged source and rejects partial, stale and nonadvancing reads', async () => {
    const source = { text: 'preview', truncated: true, contentRef: 'ref' };
    expect(
      await fullText(source, async (_, offset) => ({
        text: offset ? '末尾' : '原文',
        next: offset ? 4 : 2,
        done: !!offset,
      })),
    ).toBe('原文末尾');
    await expect(
      fullText(source, async () => ({ text: 'x', next: 0, done: false })),
    ).rejects.toThrow('未前进');
    await expect(
      fullText({ ...source, contentRef: null }, async () => {
        throw Error('unused');
      }),
    ).rejects.toThrow('暂不可用');
    await expect(
      fullText(
        source,
        async () => ({ text: 'x', next: 1, done: true }),
        () => false,
      ),
    ).rejects.toThrow('取消');
  });
});
