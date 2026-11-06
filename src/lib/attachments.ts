/** 草稿附件只保存展示与提交意图；实例身份独立于图片内容摘要。 */
import { restoreParts, type DraftPart } from './draft-parts';
import { readImages, imageTypes } from './images';
import type { MessageImage } from './types';

export type PathAttachment = {
  id: string;
  kind: 'path';
  path: string;
  name: string;
  directory: boolean;
  notice?: string;
};
export type DraftAttachment =
  { id: string; kind: 'image'; image: MessageImage } | PathAttachment;
export type DraftSnapshot = {
  text: string;
  parts: DraftPart[];
  attachments: DraftAttachment[];
};
export type ImportedFile =
  DraftAttachment | { kind: 'error'; name: string; message: string };
export type ImageBudget = { count: number; bytes: number };

export function attachmentImages(
  attachments: DraftAttachment[],
): MessageImage[] {
  return attachments.flatMap((item) =>
    item.kind === 'image' ? [item.image] : [],
  );
}
export function imageAttachment(image: MessageImage): DraftAttachment {
  return { id: crypto.randomUUID(), kind: 'image', image };
}
export function imageBudget(attachments: DraftAttachment[]): ImageBudget {
  const images = attachmentImages(attachments);
  return {
    count: images.length,
    bytes: images.reduce((sum, image) => {
      const data = image.data ?? '';
      return (
        sum +
        (data.length * 3) / 4 -
        (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0)
      );
    }, 0),
  };
}
export function pathName(path: string): string {
  return (
    path
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .at(-1) || path
  );
}
export function pathParent(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  return (
    trimmed.slice(
      0,
      Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\')),
    ) || path
  );
}
/** 校验引用语法而不访问磁盘；失效文件仍可保留、复制和修改。 */
export function absolutePath(path: string, windows?: boolean): boolean {
  if (!path || path.includes('\0')) return false;
  const win = /^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/i.test(path);
  const unix = path.startsWith('/');
  return windows === undefined ? win || unix : windows ? win : unix;
}
export function snapshotDraft(
  text: string,
  parts: DraftPart[],
  attachments: DraftAttachment[],
): DraftSnapshot {
  return {
    text,
    parts: restoreParts(parts, text),
    attachments: attachments.map((item) => ({ ...item })),
  };
}
/** 路径置于正文末尾并使用 JSON 字符串，避免斜杠命令及平台转义改变文件名。 */
export function composePrompt(draft: DraftSnapshot) {
  const paths = draft.attachments.filter(
    (item): item is PathAttachment => item.kind === 'path',
  );
  const suffix = paths.length
    ? `${draft.text ? '\n\n' : ''}文件引用：\n${paths.map((item) => JSON.stringify(item.path)).join('\n')}`
    : '';
  const parts = restoreParts(draft.parts, draft.text);
  if (suffix) parts.push({ kind: 'text', text: suffix });
  return {
    text: draft.text + suffix,
    parts,
    images: attachmentImages(draft.attachments),
    files: paths.map(({ id, path, directory }) => ({ id, path, directory })),
    fileStart: draft.text.length,
  };
}
/** 持久化只保存引用；图片丢失标记由调用方合并到恢复提示。 */
export function persistentDraft(draft: DraftSnapshot): DraftSnapshot {
  return {
    ...draft,
    attachments: draft.attachments.filter((item) => item.kind === 'path'),
  };
}
export function restoreDraft(value: unknown): DraftSnapshot | undefined {
  if (!value || typeof value !== 'object') return;
  const saved = value as Partial<DraftSnapshot>;
  if (typeof saved.text !== 'string') return;
  const ids = new Set<string>();
  const attachments: DraftAttachment[] = [];
  if (Array.isArray(saved.attachments))
    for (const item of saved.attachments) {
      if (
        !item ||
        item.kind !== 'path' ||
        typeof item.path !== 'string' ||
        !absolutePath(item.path)
      )
        continue;
      const id =
        typeof item.id === 'string' && item.id && !ids.has(item.id)
          ? item.id
          : crypto.randomUUID();
      ids.add(id);
      attachments.push({
        id,
        kind: 'path',
        path: item.path,
        name: pathName(item.path),
        directory: item.directory === true,
        ...(typeof item.notice === 'string' ? { notice: item.notice } : {}),
      });
    }
  return {
    text: saved.text,
    parts: restoreParts(saved.parts, saved.text),
    attachments,
  };
}
export function hasDraft(draft: DraftSnapshot): boolean {
  return !!(draft.text || draft.attachments.length);
}
/** 浏览器无可信本机路径；逐项处理使普通文件失败不丢失同批图片。 */
export async function importBrowserFiles(
  files: File[],
  existing: DraftAttachment[],
): Promise<ImportedFile[]> {
  const result: ImportedFile[] = [];
  const images = attachmentImages(existing);
  for (const file of files) {
    const extension = file.name.split('.').at(-1)?.toLowerCase() ?? '';
    if (
      !imageTypes.includes(file.type) &&
      !['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(extension)
    ) {
      result.push({
        kind: 'error',
        name: file.name,
        message:
          '无法取得此文件的完整路径，请通过桌面端选择或拖入文件，或手动粘贴完整路径。',
      });
      continue;
    }
    try {
      const [image] = await readImages([file], images);
      images.push(image);
      result.push(imageAttachment(image));
    } catch (cause) {
      const message =
        cause instanceof Error ? cause.message : '文件读取失败，请重试。';
      result.push({
        kind: 'error',
        name: file.name,
        message: message.startsWith(`${file.name}：`)
          ? message.slice(file.name.length + 1)
          : message,
      });
    }
  }
  return result;
}
