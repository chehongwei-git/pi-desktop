import type { Message } from './types';

/** 目录按消息身份去重，重复文字仍保留；不读取全文或请求模型摘要。 */
export function navigationMessages(
  older: Message[],
  current: Message[],
): Message[] {
  const entries = new Map<string, Message>();
  for (const message of [...older, ...current]) {
    if (message.role === 'user' && message.delivery?.state !== 'sending')
      entries.set(message.id, message);
  }
  return [...entries.values()];
}

/** 文件名兼容三平台分隔符；正文片段优先，避免把文件引用协议当作标题。 */
export function messageSummary(message: Message): string {
  const text = message.textParts?.length
    ? message.textParts
        .filter((part) => part.kind === 'text')
        .map((part) => part.text)
        .join(' ')
    : message.text;
  const clean = text.replace(/\s+/gu, ' ').trim();
  if (clean) return Array.from(clean).slice(0, 160).join('');
  const paste = message.textParts?.find((part) => part.kind === 'paste');
  if (paste)
    return `粘贴文本 · ${Array.from(paste.text.replace(/\s+/gu, ' ').trim()).slice(0, 100).join('') || `${paste.chars} 字`}`;
  const files = message.textParts?.flatMap((part) => part.files ?? []) ?? [];
  if (files.length)
    return `文件 · ${files[0].path.split(/[\\/]/u).pop() || files[0].path}${files.length > 1 ? ` 等 ${files.length} 项` : ''}`;
  if (message.images?.length) return `图片 · ${message.images.length} 张`;
  return '无文字消息';
}
