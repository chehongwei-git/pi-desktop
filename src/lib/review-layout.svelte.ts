/** 详情布局上下文：消息视图保留所有权，宿主只负责通高展示与当前选择。 */
import { untrack } from 'svelte';
export const reviewKey = Symbol('review-layout');
export class ReviewLayoutState {
  host?: HTMLElement;
  entries = $state<
    {
      owner: symbol;
      active: boolean;
      id?: string;
      close: (restoreFocus?: boolean) => void;
    }[]
  >([]);
  get current() {
    return this.entries.find((entry) => entry.active);
  }
  update(
    owner: symbol,
    active: boolean,
    id: string | undefined,
    close: (restoreFocus?: boolean) => void,
  ): void {
    untrack(() => {
      this.entries = [
        ...this.entries.filter((entry) => entry.owner !== owner),
        { owner, active, id, close },
      ];
    });
  }
  remove(owner: symbol): void {
    this.entries = this.entries.filter((entry) => entry.owner !== owner);
  }
  /** DOM 只迁移一次；关闭或切换时由原 Svelte 所有者卸载，不复制正文。 */
  mount = (node: HTMLElement) => {
    let alive = true;
    queueMicrotask(() => {
      if (alive) this.host?.appendChild(node);
    });
    return {
      destroy: () => {
        alive = false;
        node.remove();
      },
    };
  };
}
