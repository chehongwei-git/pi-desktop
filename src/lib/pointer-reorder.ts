/** 页面内部排序使用 Pointer Events，避免 Windows 原生文件拖放接管 HTML5 DragEvent。 */
export type ReorderOptions = {
  disabled: boolean;
  selector: string;
  start: () => void;
  move: (target: HTMLElement | null, after: boolean) => void;
  finish: (target: HTMLElement, after: boolean) => void;
  cancel: () => void;
};
export function pointerReorder(node: HTMLElement, initial: ReorderOptions) {
  let options = initial;
  let pointer: number | undefined;
  let startX = 0;
  let startY = 0;
  let dragging = false;
  let suppressClick = false;
  let clickTimer: ReturnType<typeof setTimeout> | undefined;
  let target: HTMLElement | null = null;
  let after = false;
  function reset(): void {
    const id = pointer;
    pointer = undefined;
    dragging = false;
    target = null;
    if (id !== undefined && node.hasPointerCapture?.(id))
      node.releasePointerCapture(id);
    options.cancel();
  }
  function down(event: PointerEvent): void {
    if (
      options.disabled ||
      event.button !== 0 ||
      event.isPrimary === false ||
      pointer !== undefined
    )
      return;
    pointer = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    node.setPointerCapture(event.pointerId);
  }
  function move(event: PointerEvent): void {
    if (pointer !== event.pointerId) return;
    if (
      !dragging &&
      Math.hypot(event.clientX - startX, event.clientY - startY) < 6
    )
      return;
    event.preventDefault();
    if (!dragging) {
      dragging = true;
      options.start();
    }
    target =
      document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest<HTMLElement>(options.selector) ?? null;
    if (target === node) target = null;
    const rect = target?.getBoundingClientRect();
    after = !!rect && event.clientY > rect.top + rect.height / 2;
    options.move(target, after);
  }
  function up(event: PointerEvent): void {
    if (pointer !== event.pointerId) return;
    if (dragging) {
      event.preventDefault();
      suppressClick = true;
      clearTimeout(clickTimer);
      clickTimer = setTimeout(() => {
        suppressClick = false;
      }, 0);
      if (target) options.finish(target, after);
    }
    reset();
  }
  function cancel(): void {
    if (pointer !== undefined) reset();
  }
  function key(event: KeyboardEvent): void {
    if (event.key === 'Escape' && pointer !== undefined) {
      event.preventDefault();
      cancel();
    }
  }
  function click(event: MouseEvent): void {
    if (!suppressClick || !event.detail) return;
    suppressClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  }
  node.addEventListener('pointerdown', down);
  node.addEventListener('pointermove', move);
  node.addEventListener('pointerup', up);
  node.addEventListener('pointercancel', cancel);
  node.addEventListener('lostpointercapture', cancel);
  node.addEventListener('click', click, true);
  window.addEventListener('blur', cancel);
  window.addEventListener('keydown', key);
  return {
    update(next: ReorderOptions) {
      options = next;
      if (options.disabled) cancel();
    },
    destroy() {
      cancel();
      clearTimeout(clickTimer);
      node.removeEventListener('pointerdown', down);
      node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerup', up);
      node.removeEventListener('pointercancel', cancel);
      node.removeEventListener('lostpointercapture', cancel);
      node.removeEventListener('click', click, true);
      window.removeEventListener('blur', cancel);
      window.removeEventListener('keydown', key);
    },
  };
}
