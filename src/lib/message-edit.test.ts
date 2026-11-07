import { expect, it, vi } from 'vitest';
import { editEntryId, restoreMessageDraft } from './message-edit';
import type { Message } from './types';
const message: Message = {
  id: 'live-1',
  role: 'user',
  text: '重复',
  thinking: '',
  status: 'done',
  name: null,
  contentRef: null,
};
it('maps repeated live messages by active branch position, not text or abandoned branches', () => {
  const nodes = [
    { id: 'a', parentId: null, label: 'user' },
    { id: 'b', parentId: 'a', label: 'user' },
    { id: 'old', parentId: 'a', label: 'user' },
  ];
  expect(
    editEntryId(message, [message, { ...message, id: 'live-2' }], nodes, 'b'),
  ).toBe('a');
  expect(editEntryId({ ...message, id: 'b' }, [], nodes, 'b')).toBe('b');
  expect(() => editEntryId(message, [message], nodes, 'missing')).toThrow(
    '不完整',
  );
});
it('restores complete text, structured paste, Windows path and paged image without reading source files', async () => {
  const path = 'C:\\work\\设计.txt';
  const suffix = `\n\n文件引用：\n${JSON.stringify(path)}`;
  const read = vi.fn(async (id: string, offset: number) =>
    id === 'image'
      ? { text: offset ? '==' : 'YWJj', next: 4, done: offset > 0 }
      : { text: '完整长文本', next: 18, done: true },
  );
  const draft = await restoreMessageDraft(
    {
      ...message,
      text: '完整长文本' + suffix,
      textParts: [
        {
          id: 'paste',
          kind: 'paste',
          text: '预览',
          truncated: true,
          contentRef: 'paste',
          chars: 6,
        },
        {
          id: 'files',
          kind: 'files',
          text: suffix,
          truncated: false,
          contentRef: null,
          chars: suffix.length,
          files: [{ id: 'file', path }],
        },
      ],
      images: [{ id: 'i', mimeType: 'image/png', contentRef: 'image' }],
    },
    read,
  );
  expect(draft.text).toBe('完整长文本');
  expect(draft.parts[0]).toMatchObject({ kind: 'paste', text: '完整长文本' });
  expect(draft.attachments[0]).toMatchObject({ kind: 'path', path });
  expect(draft.attachments[1]).toMatchObject({
    kind: 'image',
    image: { data: 'YWJj==' },
  });
});
it('rejects inconsistent metadata and unavailable images rather than silently losing content', async () => {
  const read = vi.fn().mockRejectedValue(new Error('无法读取'));
  await expect(
    restoreMessageDraft(
      { ...message, images: [{ id: 'i', mimeType: 'image/png' }] },
      read,
    ),
  ).rejects.toThrow();
  await expect(
    restoreMessageDraft(
      {
        ...message,
        textParts: [
          {
            id: 'x',
            kind: 'text',
            text: '错误内容',
            contentRef: null,
            truncated: false,
            chars: 4,
          },
        ],
      },
      read,
    ),
  ).rejects.toThrow('不一致');
});
