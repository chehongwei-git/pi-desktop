/** 进程内正文编号会重用；前端句柄必须携带所有权，重连后显式重新绑定。 */
import type { Message } from '../types';

type Reference = { runtime: string; id: string };
export class SessionContent {
  private references = new Map<string, Reference>();

  /** 所有消息入口统一转换，组件始终持有带运行时身份的句柄。 */
  bind(message: Message, runtime: string, previous?: Message): Message {
    const next = this.map(message, (id) => {
      const handle = JSON.stringify([runtime, id]);
      this.references.set(handle, { runtime, id });
      return handle;
    });
    if (!previous || !this.sameContent(previous, next)) return next;
    const oldRefs: string[] = [];
    this.map(previous, (id) => {
      oldRefs.push(id);
      return id;
    });
    let index = 0;
    const merged = this.map(next, (id) => {
      const old = oldRefs[index++];
      if (!old) return id;
      this.references.set(old, this.references.get(id)!);
      return old;
    });
    // 原完整正文可能长于新进程的预览；相同消息保持已读内容与组件句柄。
    merged.text = previous.text || next.text;
    merged.truncated = previous.text ? previous.truncated : next.truncated;
    return merged;
  }

  resolve(handle: string, runtime: string): string {
    const ref = this.references.get(handle);
    if (!ref || ref.runtime !== runtime)
      throw new Error('正文引用尚未恢复或历史已变化，请重新打开对应内容');
    return ref.id;
  }

  /** 淘汰消息时同时释放派生引用，避免历史会话数量增长造成引用表泄漏。 */
  retain(messages: Message[]): void {
    const used = new Set<string>();
    for (const message of messages)
      this.map(message, (id) => {
        used.add(id);
        return id;
      });
    for (const key of this.references.keys())
      if (!used.has(key)) this.references.delete(key);
  }
  clear(): void {
    this.references.clear();
  }

  private sameContent(old: Message, next: Message): boolean {
    const comparable = (message: Message) => {
      const result = this.map(message, () => 'reference');
      return { ...result, text: '', truncated: undefined };
    };
    return (
      (old.text === next.text ||
        !old.text ||
        (!!next.truncated && old.text.startsWith(next.text))) &&
      JSON.stringify(comparable(old)) === JSON.stringify(comparable(next))
    );
  }

  private map(message: Message, transform: (id: string) => string): Message {
    return {
      ...message,
      contentRef: message.contentRef
        ? transform(message.contentRef)
        : message.contentRef,
      tool: message.tool
        ? {
            ...message.tool,
            argsRef: message.tool.argsRef
              ? transform(message.tool.argsRef)
              : message.tool.argsRef,
            writeRef: message.tool.writeRef
              ? transform(message.tool.writeRef)
              : message.tool.writeRef,
            diffRef: message.tool.diffRef
              ? transform(message.tool.diffRef)
              : message.tool.diffRef,
          }
        : message.tool,
      textParts: message.textParts?.map((part) => ({
        ...part,
        // 技能说明与原始包装是两个独立正文引用，必须一起绑定、恢复和保留。
        skill: part.skill
          ? {
              ...part.skill,
              contentRef: part.skill.contentRef
                ? transform(part.skill.contentRef)
                : part.skill.contentRef,
            }
          : part.skill,
        contentRef: part.contentRef
          ? transform(part.contentRef)
          : part.contentRef,
      })),
      images: message.images?.map((image) => ({
        ...image,
        contentRef: image.contentRef
          ? transform(image.contentRef)
          : image.contentRef,
      })),
    };
  }
}
