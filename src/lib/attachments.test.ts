/** 附件协议边界：路径必须无损、卡片范围不能改变正文，图片不得落入持久草稿。 */
import { describe, expect, it } from 'vitest';
import {
  absolutePath,
  composePrompt,
  imageAttachment,
  imageBudget,
  persistentDraft,
  restoreDraft,
  snapshotDraft,
  type PathAttachment,
} from './attachments';
import { draftText } from './draft-parts';
import { textRanges } from './text-presentation';
const reference = (path: string): PathAttachment => ({
  id: crypto.randomUUID(),
  kind: 'path',
  path,
  name: '文件',
  directory: false,
});
const image = { id: 'hash', mimeType: 'image/png', data: 'aA==' };

describe('attachment snapshots', () => {
  it('round trips platform paths without interpreting slash commands or escaping names', () => {
    const paths = [
      '/Users/小明/a b.ts',
      'C:\\work\\中文\\a.txt',
      '\\\\server\\share\\a.txt',
      '/tmp/a"b`c\nd.txt',
    ];
    const prompt = composePrompt(snapshotDraft('', [], paths.map(reference)));
    expect(prompt.text.split('\n')[0]).toBe('文件引用：');
    expect(
      prompt.text
        .split('\n')
        .slice(1)
        .map((line) => JSON.parse(line)),
    ).toEqual(paths);
    expect(prompt.images).toEqual([]);
  });
  it('retains paste-card ranges and appends references as ordinary text', () => {
    const parts = [
      { kind: 'text' as const, text: '检查\n' },
      { kind: 'paste' as const, id: 'paste', text: '完整原文' },
    ];
    const prompt = composePrompt(
      snapshotDraft(draftText(parts), parts, [
        imageAttachment(image),
        reference('/tmp/a.ts'),
      ]),
    );
    const ranges = textRanges(prompt.parts, prompt.text)!;
    expect(prompt.text).toBe('检查\n完整原文\n\n文件引用：\n"/tmp/a.ts"');
    expect(prompt.images).toEqual([image]);
    expect(ranges.find((range) => range.kind === 'paste')).toEqual({
      kind: 'paste',
      id: 'paste',
      start: 3,
      end: 7,
    });
    expect(
      ranges.map((range) => prompt.text.slice(range.start, range.end)).join(''),
    ).toBe(prompt.text);
    expect(ranges.at(-1)?.kind).toBe('text');
  });
  it('persists only path references and restores independently from image data', () => {
    const path = reference('/tmp/report.pdf');
    const draft = snapshotDraft('检查', [], [imageAttachment(image), path]);
    const saved = JSON.parse(JSON.stringify(persistentDraft(draft)));
    expect(JSON.stringify(saved)).not.toContain(image.data);
    const restored = restoreDraft(saved)!;
    expect(restored.text).toBe('检查');
    expect(restored.attachments).toEqual([{ ...path, name: 'report.pdf' }]);
    expect(draft.attachments).toHaveLength(2);
  });
  it('validates stored references and assigns distinct identities to duplicate records', () => {
    const path = reference('/tmp/a.txt');
    const restored = restoreDraft({
      text: '',
      attachments: [
        path,
        path,
        { ...path, path: 'relative' },
        imageAttachment(image),
        null,
      ],
    })!;
    expect(restored.attachments).toHaveLength(2);
    expect(new Set(restored.attachments.map((item) => item.id)).size).toBe(2);
    expect(restoreDraft({ text: 42 })).toBeUndefined();
  });
  it('checks platform syntax and counts actual base64 bytes rather than encoded length', () => {
    expect(absolutePath('C:\\work\\file', true)).toBe(true);
    expect(absolutePath('C:file', true)).toBe(false);
    expect(absolutePath('\\\\server\\share\\file', true)).toBe(true);
    expect(absolutePath('/tmp/a', false)).toBe(true);
    expect(absolutePath('/tmp/a', true)).toBe(false);
    expect(absolutePath('/tmp/\0a', false)).toBe(false);
    expect(
      imageBudget([imageAttachment(image), reference('/tmp/huge.zip')]),
    ).toEqual({ count: 1, bytes: 1 });
  });
});
