/** 与宿主一致的附件预算，编码后仍低于 Pi 的 64 MiB 记录上限。 */
import type { MessageImage } from './types';
export const imageTypes = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
];
export const imageLimit = 10 * 1024 * 1024;
export const imagesLimit = 24 * 1024 * 1024;
const extensionTypes: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};
function mimeType(file: File): string {
  return imageTypes.includes(file.type)
    ? file.type
    : (extensionTypes[file.name.split('.').at(-1)?.toLowerCase() ?? ''] ?? '');
}
/** 与宿主使用相同签名规则，浏览器的 MIME 和扩展名都不能单独证明内容有效。 */
function validSignature(data: string, mime: string): boolean {
  const header = atob(data.slice(0, 24));
  if (mime === 'image/png') return header.startsWith('\x89PNG\r\n\x1a\n');
  if (mime === 'image/jpeg') return header.startsWith('\xff\xd8\xff');
  if (mime === 'image/gif')
    return header.startsWith('GIF87a') || header.startsWith('GIF89a');
  return (
    mime === 'image/webp' &&
    header.startsWith('RIFF') &&
    header.slice(8, 12) === 'WEBP'
  );
}
/** 先检查预算再读取，避免拖入大文件时无谓分配 Base64。 */
export async function readImages(
  files: File[],
  existing: MessageImage[],
): Promise<MessageImage[]> {
  if (files.length + existing.length > 8)
    throw new Error('每条消息最多添加 8 张图片。');
  let total = existing.reduce((sum, image) => {
    const data = image.data ?? '';
    return (
      sum +
      (data.length * 3) / 4 -
      (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0)
    );
  }, 0);
  for (const file of files) {
    if (!mimeType(file))
      throw new Error(`${file.name}：支持 PNG、JPEG、WebP 和 GIF 图片。`);
    if (!file.size || file.size > imageLimit)
      throw new Error(`${file.name}：图片不能为空且不能超过 10 MiB。`);
    total += file.size;
  }
  if (total > imagesLimit)
    throw new Error('每条消息的图片总大小不能超过 24 MiB。');
  return Promise.all(
    files.map(
      (file) =>
        new Promise<MessageImage>((resolve, reject) => {
          const reader = new FileReader();
          reader.onerror = () =>
            reject(new Error(`${file.name}：图片读取失败，请重试。`));
          reader.onload = () => {
            const data = String(reader.result).split(',')[1];
            const mime = mimeType(file);
            if (!validSignature(data, mime)) {
              reject(
                new Error(`${file.name}：图片内容与格式不符，请重新选择。`),
              );
              return;
            }
            // 对协议中的 Base64 做摘要，宿主无需解码即可关联正式消息。
            void crypto.subtle
              .digest('SHA-256', new TextEncoder().encode(data))
              .then((hash) => {
                const id = Array.from(new Uint8Array(hash), (b) =>
                  b.toString(16).padStart(2, '0'),
                ).join('');
                resolve({
                  id,
                  name: file.name || '剪贴板图片',
                  mimeType: mime,
                  data,
                });
              }, reject);
          };
          reader.readAsDataURL(file);
        }),
    ),
  );
}
