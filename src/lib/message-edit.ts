/** 历史编辑独立于底部草稿；只有完整读取成功后才允许重发。 */
import { imageAttachment, pathName, type DraftSnapshot } from './attachments';
import { fullText } from './text-presentation';
import type { ContentPage, Message } from './types';
export interface MessageEdit {
  message: Message;
  draft: DraftSnapshot;
  loading: boolean;
  busy: boolean;
  error: string;
  session?: string;
  branch?: string;
  uncertain?: boolean;
}
export async function restoreMessageDraft(
  message: Message,
  read: (id: string, offset: number) => Promise<ContentPage>,
  active = () => true,
): Promise<DraftSnapshot> {
  const text = await fullText(
    {
      ...message,
      truncated: message.truncated || (!message.text && !!message.contentRef),
    },
    read,
    active,
  );
  const draft: DraftSnapshot = { text, parts: [], attachments: [] };
  if (message.textParts?.length) {
    const parts = [];
    let assembled = '';
    for (const part of message.textParts) {
      const body = await fullText(part, read, active);
      assembled += body;
      if (part.kind === 'files' && part.files?.length) {
        draft.attachments.push(
          ...part.files.map((file) => ({
            id: file.id,
            kind: 'path' as const,
            path: file.path,
            name: pathName(file.path),
            directory: !!file.directory,
          })),
        );
      } else
        parts.push(
          part.kind === 'paste'
            ? { kind: 'paste' as const, id: part.id, text: body }
            : { kind: 'text' as const, text: body },
        );
    }
    // 展示元数据必须与权威全文一致，避免过期范围造成静默丢字。
    if (assembled !== text)
      throw new Error('原消息片段不一致，请重新打开会话后编辑。');
    draft.parts = parts;
    draft.text = parts.map((part) => part.text).join('');
  }
  for (const image of message.images ?? []) {
    const data =
      image.data ??
      (await fullText(
        { text: '', truncated: true, contentRef: image.contentRef ?? null },
        read,
        active,
      ));
    if (!data) throw new Error('原图片无法恢复，请重新打开会话后编辑。');
    draft.attachments.push(imageAttachment({ ...image, data }));
  }
  if (!active()) throw new Error('读取已取消');
  return draft;
}
/** 实时投影 ID 与 Pi entryId 不同；按当前分支用户消息的尾部相对位置对齐，不按重复文字猜测。 */
export function editEntryId(
  message: Message,
  visible: Message[],
  nodes: { id: string; parentId: string | null; label: string }[],
  leafId: string | null,
): string {
  const map = new Map(nodes.map((node) => [node.id, node]));
  const users: string[] = [];
  const seen = new Set<string>();
  let id = leafId;
  while (id) {
    if (seen.has(id)) throw new Error('会话分支无效，请重新加载。');
    seen.add(id);
    const node = map.get(id);
    if (!node) throw new Error('会话分支不完整，请重新加载。');
    if (node.label === 'user') users.push(id);
    id = node.parentId;
  }
  if (users.includes(message.id)) return message.id;
  const index = visible.findIndex((item) => item.id === message.id);
  if (index < 0) throw new Error('原消息已变化，请重新编辑。');
  const after = visible
    .slice(index + 1)
    .filter((item) => item.role === 'user' && !item.delivery).length;
  const entry = users[after];
  if (!entry) throw new Error('无法定位原消息，请重新打开会话后编辑。');
  return entry;
}
