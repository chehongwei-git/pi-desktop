/** 集中 reducer：局部修改消息槽位，不在每个 token 深拷贝历史。无 DOM/IPC 副作用。 */
import type { AppEvent, Message, RunState } from '../types';
export interface Transcript {
  messages: Message[];
  run: RunState;
}
/** 数组身份缓存 ID 索引：分页替换数组才重建，token 更新保持 O(1) 查找。 */
const lookups = new WeakMap<Message[], Map<string, number>>();
/** 稳定 ID 更新；单批增量先合并后写 Svelte 状态，防止高频无意义渲染。 */
export function reduceEvents(state: Transcript, events: AppEvent[]): void {
  let indexes = lookups.get(state.messages);
  if (!indexes) {
    indexes = new Map(
      state.messages.map((message, index) => [message.id, index]),
    );
    lookups.set(state.messages, indexes);
  }
  for (const event of events) {
    if (event.type === 'reset') {
      state.messages = [];
      indexes.clear();
      lookups.set(state.messages, indexes);
      state.run = 'idle';
    }
    if (event.type === 'run') state.run = event.state;
    if (event.type === 'message') {
      let index = indexes.get(event.message.id);
      if (index === undefined && event.message.role === 'user') {
        const pending = state.messages.findIndex(
          (message) => message.delivery && message.text === event.message.text,
        );
        if (pending >= 0) {
          index = pending;
          indexes.delete(state.messages[pending].id);
          indexes.set(event.message.id, pending);
        }
      }
      if (index === undefined) {
        indexes.set(event.message.id, state.messages.length);
        state.messages.push(event.message);
      } else state.messages[index] = event.message;
    }
    if (event.type === 'delta') {
      const index = indexes.get(event.id);
      if (index === undefined) continue;
      const message = state.messages[index];
      // 前端仅维护 64KiB 预览；message_end 会提供完整正文引用。
      message[event.field] = (message[event.field] + event.delta).slice(
        0,
        65536,
      );
    }
  }
}
/** 当前项目按本地日期分组，避免 UTC 午夜造成“今天”错位。 */
export function dateGroup(timestamp: number, now = new Date()): string {
  const day = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const date = new Date(timestamp);
  const then = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  ).getTime();
  const days = Math.round((day - then) / 86400000);
  return days <= 0
    ? '今天'
    : days === 1
      ? '昨天'
      : days < 7
        ? '最近 7 天'
        : '更早';
}
/** IME 的 Enter 与普通回车必须区分；keydown.keyCode=229 是旧 WebView 的兜底。 */
export function shouldSend(
  event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'isComposing' | 'keyCode'>,
  composing: boolean,
): boolean {
  return (
    event.key === 'Enter' &&
    !event.shiftKey &&
    !event.isComposing &&
    event.keyCode !== 229 &&
    !composing
  );
}
