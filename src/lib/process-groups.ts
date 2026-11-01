import type { Message, ProcessInfo } from './types';

export type TranscriptRow =
  | { kind: 'message'; id: string; message: Message }
  | { kind: 'process'; id: string; messages: Message[]; info?: ProcessInfo };

/** 普通正文始终可见；仅将正文之间连续的工具与思考合并，单次线性遍历。 */
export function processRows(messages: Message[]): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  let group: Extract<TranscriptRow, { kind: 'process' }> | undefined;
  const usedIds = new Set<string>();
  for (const message of messages) {
    const assistant = message.role === 'assistant';
    if (message.role === 'toolResult' || (assistant && message.thinking)) {
      if (!group) {
        const base = `process-${message.process?.id ?? message.id}`;
        const id = usedIds.has(base) ? `${base}-${message.id}` : base;
        usedIds.add(id);
        group = { kind: 'process', id, messages: [], info: message.process };
        rows.push(group);
      }
      if (message.process?.id === group.info?.id) group.info = message.process;
      else group.info = undefined;
      group.messages.push(
        message.role === 'toolResult'
          ? message
          : {
              ...message,
              text: '',
              contentRef: null,
              images: [],
            },
      );
    }
    // 已加载的完整空白正文不切断过程；空预览可能是缓存淘汰，截断预览也不能代表全文。
    // 这两类引用仍需挂载读取，避免将真实回复误并入过程。
    if (
      (!assistant && message.role !== 'toolResult') ||
      (assistant &&
        (message.text.trim() ||
          (message.contentRef && (!message.text || message.truncated)) ||
          message.images?.length))
    ) {
      rows.push({
        kind: 'message',
        id: message.id,
        message: assistant ? { ...message, thinking: '' } : message,
      });
      if (assistant || !message.delivery) group = undefined;
    }
  }
  return rows;
}

/** 只显示有依据的耗时，时钟回拨时至少为零。 */
export function processDuration(
  info: ProcessInfo | undefined,
  now: number,
): string {
  if (
    info?.startedAt == null ||
    (info.state !== 'running' && info.endedAt == null)
  )
    return '';
  const seconds = Math.max(
    0,
    // 暂停时固定取提问时刻，恢复后只扣除已累计的等待时间。
    Math.floor(
      ((info.pausedAt ?? info.endedAt ?? now) -
        info.startedAt -
        (info.pausedMs ?? 0)) /
        1000,
    ),
  );
  if (seconds < 1) return '<1 秒';
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds < 3600)
    return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
  return `${Math.floor(seconds / 3600)} 小时 ${Math.floor((seconds % 3600) / 60)} 分`;
}
