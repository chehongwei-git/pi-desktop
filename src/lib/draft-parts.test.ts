import { describe, expect, it } from 'vitest';
import {
  draftText,
  foldable,
  replaceParts,
  restoreParts,
  type DraftPart,
} from './draft-parts';

describe('long paste representation', () => {
  it('counts Unicode code points and all clipboard newline conventions', () => {
    expect(foldable('😀'.repeat(999))).toBe(false);
    expect(foldable('😀'.repeat(1000))).toBe(true);
    for (const newline of ['\r\n', '\r', '\n']) {
      expect(foldable(Array(11).fill('a').join(newline))).toBe(false);
      expect(foldable(Array(12).fill('a').join(newline))).toBe(true);
    }
    expect(foldable(' \n'.repeat(1000))).toBe(false);
  });
  it('preserves exact original text and order when inserting and replacing selections', () => {
    const card: DraftPart = {
      kind: 'paste',
      id: 'a',
      text: '中文\r\n😀\tcode',
    };
    const parts = replaceParts(
      [{ kind: 'text', text: 'before AFTER' }],
      7,
      12,
      [card],
    );
    expect(draftText(parts)).toBe('before ' + card.text);
    const second = replaceParts(parts, 0, 7, [{ kind: 'text', text: '看：' }]);
    expect(second[1]).toEqual(card);
    expect(draftText(second)).toBe('看：' + card.text);
    expect(replaceParts(second, 2, draftText(second).length, [])).toEqual([
      { kind: 'text', text: '看：' },
    ]);
  });
  it('restores valid cards but falls back losslessly for corrupt or legacy drafts', () => {
    const parts: DraftPart[] = [{ kind: 'paste', id: 'x', text: 'saved' }];
    expect(restoreParts(parts, 'saved')).toEqual(parts);
    for (const value of [
      undefined,
      {},
      [null],
      [{ kind: 'paste', text: 'saved' }],
      [...parts, ...parts],
    ]) {
      expect(restoreParts(value, 'saved')).toEqual([
        { kind: 'text', text: 'saved' },
      ]);
    }
    expect(restoreParts(parts, 'new draft')).toEqual([
      { kind: 'text', text: 'new draft' },
    ]);
  });
});
