/** 卡片只是全文的显示方式；片段拼接不添加分隔符，避免改变代码和提示词。 */
export type DraftPart =
  { kind: 'text'; text: string } | { kind: 'paste'; id: string; text: string };
export const draftText = (parts: DraftPart[]): string =>
  parts.map((part) => part.text).join('');
export function foldable(text: string): boolean {
  return (
    !!text.trim() &&
    (Array.from(text).length >= 1000 || text.split(/\r\n|\r|\n/).length >= 12)
  );
}
export function normalizeParts(parts: DraftPart[]): DraftPart[] {
  const result: DraftPart[] = [];
  for (const part of parts) {
    if (!part.text && part.kind === 'text') continue;
    const previous = result.at(-1);
    if (part.kind === 'text' && previous?.kind === 'text')
      previous.text += part.text;
    else result.push({ ...part });
  }
  return result;
}
/** 存储损坏或旧版本只恢复纯文本；不根据内容猜测原来的折叠边界。 */
export function restoreParts(value: unknown, text: string): DraftPart[] {
  if (!Array.isArray(value)) return [{ kind: 'text', text }];
  const ids = new Set<string>();
  for (const part of value) {
    if (
      !part ||
      typeof part.text !== 'string' ||
      !['text', 'paste'].includes(part.kind)
    )
      return [{ kind: 'text', text }];
    if (part.kind === 'paste') {
      if (typeof part.id !== 'string' || !part.id || ids.has(part.id))
        return [{ kind: 'text', text }];
      ids.add(part.id);
    }
  }
  return draftText(value) === text
    ? normalizeParts(value)
    : [{ kind: 'text', text }];
}
/** 选区使用全文 UTF-16 偏移，和 textarea/DOM Range 的索引一致。 */
export function replaceParts(
  parts: DraftPart[],
  start: number,
  end: number,
  inserted: DraftPart[],
): DraftPart[] {
  const before: DraftPart[] = [];
  const after: DraftPart[] = [];
  let offset = 0;
  for (const part of parts) {
    const next = offset + part.text.length;
    if (next <= start) before.push(part);
    else if (offset < start)
      before.push({ kind: 'text', text: part.text.slice(0, start - offset) });
    if (offset >= end) after.push(part);
    else if (next > end)
      after.push({ kind: 'text', text: part.text.slice(end - offset) });
    offset = next;
  }
  return normalizeParts([...before, ...inserted, ...after]);
}
