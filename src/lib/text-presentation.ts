/** 发送快照只描述范围；原文始终由 prompt 和宿主正文引用负责传递。 */
import { draftText, normalizeParts, type DraftPart } from './draft-parts';
import type { ContentPage, Message, MessageTextPart, TextRange } from './types';
export function textRanges(
  parts: DraftPart[],
  text: string,
): TextRange[] | undefined {
  if (!parts.some((p) => p.kind === 'paste') || draftText(parts) !== text)
    return;
  let offset = 0;
  return normalizeParts(parts).map((part, index) => {
    const start = offset;
    offset += part.text.length;
    return {
      kind: part.kind,
      id: part.kind === 'paste' ? part.id : `text-${index}`,
      start,
      end: offset,
    };
  });
}
export function localTextParts(
  parts: DraftPart[],
  text: string,
): MessageTextPart[] | undefined {
  return textRanges(parts, text)?.map((range) => {
    const body = text.slice(range.start, range.end);
    return {
      kind: range.kind,
      id: range.id,
      text: body,
      chars: Array.from(body).length,
      truncated: false,
      contentRef: null,
    };
  });
}
export function textPreview(text: string): string {
  return Array.from(
    text
      .split(/\r\n|\r|\n/)
      .slice(0, 6)
      .join('\n'),
  )
    .slice(0, 360)
    .join('');
}
/** 分页读取校验前进并让出主线程；引用失效或取消不返回伪装成全文的预览。 */
export async function fullText(
  source: Pick<Message, 'text' | 'contentRef' | 'truncated'>,
  read: (id: string, offset: number) => Promise<ContentPage>,
  active = () => true,
): Promise<string> {
  if (!source.truncated) return source.text;
  if (!source.contentRef) throw new Error('全文暂不可用，请重新打开会话后重试');
  const chunks: string[] = [];
  let offset = 0;
  while (active()) {
    const page = await read(source.contentRef, offset);
    if (!active()) throw new Error('读取已取消');
    chunks.push(page.text);
    if (page.done) return chunks.join('');
    if (page.next <= offset) throw new Error('正文读取未前进，请重试');
    offset = page.next;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('读取已取消');
}
