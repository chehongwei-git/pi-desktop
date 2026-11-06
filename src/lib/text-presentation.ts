/** 发送快照只描述范围；原文始终由 prompt 和宿主正文引用负责传递。 */
import { draftText, normalizeParts, type DraftPart } from './draft-parts';
import type {
  ContentPage,
  Message,
  MessageFileReference,
  MessageTextPart,
  TextRange,
} from './types';
export function textRanges(
  parts: DraftPart[],
  text: string,
  files: MessageFileReference[] = [],
  fileStart = text.length,
): TextRange[] | undefined {
  if (
    (!files.length && !parts.some((p) => p.kind === 'paste')) ||
    draftText(parts) !== text
  )
    return;
  let offset = 0;
  const source = files.length
    ? restorePresentationParts(parts, fileStart)
    : normalizeParts(parts);
  const ranges: TextRange[] = source.map((part, index) => {
    const start = offset;
    offset += part.text.length;
    return {
      kind: part.kind,
      id: part.kind === 'paste' ? part.id : `text-${index}`,
      start,
      end: offset,
    };
  });
  if (files.length)
    ranges.push({
      kind: 'files',
      id: 'file-references',
      start: fileStart,
      end: text.length,
      files,
    });
  return ranges;
}
/** 文件区块从正文边界独立切分，保留此前长粘贴片段的原子边界。 */
function restorePresentationParts(
  parts: DraftPart[],
  end: number,
): DraftPart[] {
  let remaining = end;
  const result: DraftPart[] = [];
  for (const part of parts) {
    if (remaining <= 0) break;
    const text = part.text.slice(0, remaining);
    if (text) result.push({ ...part, text });
    remaining -= text.length;
  }
  return normalizeParts(result);
}
export function localTextParts(
  parts: DraftPart[],
  text: string,
  files: MessageFileReference[] = [],
  fileStart = text.length,
): MessageTextPart[] | undefined {
  return textRanges(parts, text, files, fileStart)?.map((range) => {
    const body = text.slice(range.start, range.end);
    return {
      kind: range.kind,
      files: range.files,
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
