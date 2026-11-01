import type { Message, RunState } from './types';

export interface ConversationActivity {
  label: string;
  paused: boolean;
  stopping: boolean;
}

/** 只用明确的运行事件和本轮消息推导状态；排队消息不切断正在执行的轮次。 */
export function conversationActivity(
  run: RunState,
  messages: Message[],
  waiting = false,
): ConversationActivity | null {
  if (run === 'idle') return null;
  const activity = (label: string, paused = false): ConversationActivity => ({
    label,
    paused,
    stopping: run === 'aborting',
  });
  if (run === 'aborting') return activity('正在停止任务');
  if (waiting) return activity('等待你的操作', true);
  if (run === 'retrying') return activity('正在重试');
  if (run === 'compacting') return activity('正在压缩上下文');

  let tools = 0;
  let streamingText = false;
  let thinking = false;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === 'user' && !message.delivery) break;
    if (message.role === 'toolResult' && message.status === 'running') tools++;
    if (message.role === 'assistant' && message.status === 'streaming') {
      streamingText ||= !!message.text.trim();
      thinking ||= !!message.thinking;
    }
  }
  if (tools)
    return activity(
      tools > 1 ? `正在执行工具 · ${tools} 项进行中` : '正在执行工具',
    );
  // 可见正文的光标已经表达生成中，避免同一时刻再出现圆点动画。
  if (streamingText) return null;
  return activity(thinking ? '正在思考' : 'Pi 正在处理');
}
