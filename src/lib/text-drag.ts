/** 原生文件拖放会接管 Windows OLE；编辑器内选中文字改用指针事件，避免依赖 HTML5 拖放。 */
interface Selection {
  start: number;
  end: number;
}
interface TextDragOptions {
  enabled: boolean;
  value: string;
  context: string;
  selection: () => Selection;
  select: (start: number, end: number) => void;
  point: (x: number, y: number) => number | undefined;
  move: (selection: Selection, target: number, copy: boolean) => void;
}

/** 两种 WebView 的坐标到 DOM 光标接口均返回 UTF-16 偏移。 */
export function caretPoint(
  x: number,
  y: number,
): { node: Node; offset: number } | undefined {
  const host = document as Document & {
    caretPositionFromPoint?: (
      x: number,
      y: number,
    ) => { offsetNode: Node; offset: number } | null;
  };
  const point = host.caretPositionFromPoint?.(x, y);
  if (point) return { node: point.offsetNode, offset: point.offset };
  const range = document.caretRangeFromPoint?.(x, y);
  if (range) return { node: range.startContainer, offset: range.startOffset };
}

/** textarea 的内部文本节点不可访问；临时透明镜像仅用于命中测试，不改变草稿或原选区。 */
export function textareaPoint(
  node: HTMLTextAreaElement,
  x: number,
  y: number,
): number | undefined {
  const mirror = document.createElement('div');
  const style = getComputedStyle(node);
  for (const property of [
    'box-sizing',
    'width',
    'height',
    'font-family',
    'font-size',
    'font-weight',
    'font-style',
    'line-height',
    'letter-spacing',
    'word-spacing',
    'text-indent',
    'text-align',
    'direction',
    'tab-size',
    'padding-top',
    'padding-right',
    'padding-bottom',
    'padding-left',
    'border-top-width',
    'border-right-width',
    'border-bottom-width',
    'border-left-width',
  ])
    mirror.style.setProperty(property, style.getPropertyValue(property));
  Object.assign(mirror.style, {
    position: 'fixed',
    left: '0',
    top: '0',
    margin: '0',
    opacity: '0',
    zIndex: '2147483647',
    pointerEvents: 'auto',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'break-word',
    overflowX: style.overflowX,
    overflowY: style.overflowY,
    borderStyle: 'solid',
  });
  mirror.setAttribute('aria-hidden', 'true');
  mirror.textContent = node.value + '\u200b';
  document.body.append(mirror);
  try {
    const rect = node.getBoundingClientRect();
    const boxWidth =
      parseFloat(style.width) +
      (style.boxSizing === 'border-box'
        ? 0
        : [
            'paddingLeft',
            'paddingRight',
            'borderLeftWidth',
            'borderRightWidth',
          ].reduce(
            (sum, key) =>
              sum +
              (parseFloat(style[key as keyof CSSStyleDeclaration] as string) ||
                0),
            0,
          ));
    // 镜像与输入框共享页面缩放；定位值先还原为布局像素，避免 CSS zoom 下重复缩放。
    const scale = mirror.getBoundingClientRect().width / boxWidth || 1;
    mirror.style.left = `${rect.left / scale}px`;
    mirror.style.top = `${rect.top / scale}px`;
    mirror.scrollTop = node.scrollTop;
    mirror.scrollLeft = node.scrollLeft;
    const point = caretPoint(x, y);
    if (point && mirror.contains(point.node)) {
      const at =
        point.node === mirror
          ? point.offset
            ? node.value.length
            : 0
          : point.offset;
      return Math.min(at, node.value.length);
    }
  } finally {
    mirror.remove();
  }
}

/** 只接管已有选区的鼠标拖动；普通点击、触摸选字及输入法仍由原生编辑器处理。 */
export function textDrag(node: HTMLElement, initial: TextDragOptions) {
  let options = initial;
  let pending:
    | (Selection & {
        id: number;
        x: number;
        y: number;
        target?: number;
        dragging: boolean;
      })
    | undefined;
  let suppressClick = false;
  let clickTimer: ReturnType<typeof setTimeout> | undefined;
  function reset(restore = true) {
    const old = pending;
    pending = undefined;
    if (old && restore) options.select(old.start, old.end);
    if (old && node.hasPointerCapture(old.id))
      node.releasePointerCapture(old.id);
    node.classList.remove('dragging-text');
  }
  function down(event: PointerEvent) {
    if (
      !options.enabled ||
      event.button !== 0 ||
      event.pointerType !== 'mouse' ||
      event.shiftKey
    )
      return;
    const selected = options.selection();
    if (selected.start === selected.end) return;
    const point = options.point(event.clientX, event.clientY);
    if (point === undefined || point < selected.start || point >= selected.end)
      return;
    event.preventDefault();
    node.focus({ preventScroll: true });
    pending = {
      ...selected,
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      dragging: false,
      target: point,
    };
    node.setPointerCapture(event.pointerId);
  }
  function move(event: PointerEvent) {
    if (!pending || event.pointerId !== pending.id) return;
    if (
      !pending.dragging &&
      Math.hypot(event.clientX - pending.x, event.clientY - pending.y) < 5
    )
      return;
    pending.dragging = true;
    node.classList.add('dragging-text');
    event.preventDefault();
    const box = node.getBoundingClientRect();
    pending.target =
      event.clientX >= box.left &&
      event.clientX <= box.right &&
      event.clientY >= box.top &&
      event.clientY <= box.bottom
        ? options.point(event.clientX, event.clientY)
        : undefined;
    if (pending.target !== undefined)
      options.select(pending.target, pending.target);
  }
  function up(event: PointerEvent) {
    if (!pending || event.pointerId !== pending.id) return;
    const old = pending;
    reset();
    if (!old.dragging) {
      if (old.target !== undefined) options.select(old.target, old.target);
      return;
    }
    suppressClick = true;
    clearTimeout(clickTimer);
    clickTimer = setTimeout(() => {
      suppressClick = false;
    }, 0);
    if (old.target !== undefined)
      options.move(
        old,
        old.target,
        /Mac/i.test(navigator.platform) ? event.altKey : event.ctrlKey,
      );
  }
  function cancel() {
    reset();
  }
  function key(event: KeyboardEvent) {
    if (pending && event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      cancel();
    }
  }
  function click(event: MouseEvent) {
    if (suppressClick) {
      event.preventDefault();
      event.stopImmediatePropagation();
      suppressClick = false;
    }
  }
  function nativeDrag(event: DragEvent) {
    if (pending) event.preventDefault();
  }
  node.addEventListener('pointerdown', down);
  node.addEventListener('pointermove', move);
  node.addEventListener('pointerup', up);
  node.addEventListener('pointercancel', cancel);
  node.addEventListener('lostpointercapture', cancel);
  node.addEventListener('click', click, true);
  node.addEventListener('dragstart', nativeDrag);
  window.addEventListener('keydown', key, true);
  window.addEventListener('blur', cancel);
  return {
    update(next: TextDragOptions) {
      if (
        !next.enabled ||
        next.context !== options.context ||
        next.value !== options.value
      )
        reset(false);
      options = next;
    },
    destroy() {
      reset(false);
      clearTimeout(clickTimer);
      node.removeEventListener('pointerdown', down);
      node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerup', up);
      node.removeEventListener('pointercancel', cancel);
      node.removeEventListener('lostpointercapture', cancel);
      node.removeEventListener('click', click, true);
      node.removeEventListener('dragstart', nativeDrag);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', cancel);
    },
  };
}
