<!-- 纯文字保留原生 textarea；首次收纳后使用原子卡片，全文始终由片段保存。 -->
<script lang="ts">
  import Icon from './Icon.svelte';
  import { tick, untrack } from 'svelte';
  import { caretPoint, textareaPoint, textDrag } from '../text-drag';
  import {
    draftText,
    foldable,
    moveParts,
    normalizeParts,
    replaceParts,
    restoreParts,
    type DraftPart,
  } from '../draft-parts';
  let {
    value = $bindable(''),
    parts = $bindable<DraftPart[]>([]),
    disabled = false,
    placeholder = '',
    label = '消息输入',
    allowFold = true,
    context = '',
    controls,
    activeDescendant,
    onkeydown,
    onpaste,
    oninput,
    oncompositionstart,
    oncompositionend,
  }: {
    value?: string;
    parts?: DraftPart[];
    disabled?: boolean;
    placeholder?: string;
    label?: string;
    allowFold?: boolean;
    context?: string;
    controls?: string;
    activeDescendant?: string;
    onkeydown: (event: KeyboardEvent) => void;
    onpaste: (event: ClipboardEvent) => void;
    oninput: () => void;
    oncompositionstart: () => void;
    oncompositionend: () => void;
  } = $props();
  let plain = $state<HTMLTextAreaElement>()!;
  let root = $state<HTMLDivElement>()!;
  let iconTemplate: HTMLSpanElement;
  let rich = $state(false);
  let notice = $state('');
  let composing = $state(false);
  let current: DraftPart[] = [];
  let initialized = false;
  let synced = '';
  let oldContext = '';
  let undo: { parts: DraftPart[]; start: number; end: number }[] = [];
  let redo: typeof undo = [];
  let pendingInput: ReturnType<typeof snapshot> | undefined;
  let hasCards = $derived(parts.some((part) => part.kind === 'paste'));

  /** 外部草稿替换必须丢弃旧撤销栈，避免跨会话恢复出别人的文字。 */
  $effect(() => {
    const text = value;
    const key = context;
    const stored = parts;
    untrack(() => {
      if (
        initialized &&
        text === synced &&
        key === oldContext &&
        draftText(current) === text
      )
        return;
      initialized = true;
      current = restoreParts(stored, text);
      synced = text;
      oldContext = key;
      rich = current.some((part) => part.kind === 'paste');
      undo = [];
      redo = [];
      parts = current;
      void tick().then(() => paint());
    });
  });
  $effect(() => {
    value;
    if (plain) {
      plain.style.height = 'auto';
      plain.style.height = `${Math.min(plain.scrollHeight, 200)}px`;
    }
  });
  export function focus(): void {
    (rich ? root : plain)?.focus();
  }
  /** 卡片 DOM 不包含原文；Range 的可见位置映射到全文偏移。 */
  function length(node: Node): number {
    if (node instanceof HTMLElement && node.dataset.pasteId) {
      return (
        current.find((p) => p.kind === 'paste' && p.id === node.dataset.pasteId)
          ?.text.length ?? 0
      );
    }
    if (node.nodeType === Node.TEXT_NODE) return node.textContent?.length ?? 0;
    if (node.nodeName === 'BR') return 1;
    return Array.from(node.childNodes).reduce(
      (sum, child) => sum + length(child),
      0,
    );
  }
  function offset(node: Node, at: number): number {
    let result =
      node.nodeType === Node.TEXT_NODE
        ? at
        : Array.from(node.childNodes)
            .slice(0, at)
            .reduce((sum, child) => sum + length(child), 0);
    while (node !== root && node.parentNode) {
      for (const sibling of Array.from(node.parentNode.childNodes)) {
        if (sibling === node) break;
        result += length(sibling);
      }
      node = node.parentNode;
    }
    return result;
  }
  export function selection(): { start: number; end: number } {
    if (!rich)
      return {
        start: plain?.selectionStart ?? 0,
        end: plain?.selectionEnd ?? 0,
      };
    const selected = window.getSelection();
    if (!root || !selected?.rangeCount)
      return { start: value.length, end: value.length };
    const range = selected.getRangeAt(0);
    if (
      !root.contains(range.startContainer) ||
      !root.contains(range.endContainer)
    )
      return { start: value.length, end: value.length };
    return {
      start: offset(range.startContainer, range.startOffset),
      end: offset(range.endContainer, range.endOffset),
    };
  }
  export function setSelectionRange(start: number, end: number): void {
    if (!rich) {
      plain?.setSelectionRange(start, end);
      return;
    }
    if (!root) return;
    const point = (position: number): [Node, number] => {
      let total = 0;
      for (let index = 0; index < root.childNodes.length; index++) {
        const node = root.childNodes[index];
        const size = length(node);
        if (position <= total + size) {
          if (node.nodeType === Node.TEXT_NODE)
            return [node, Math.max(0, position - total)];
          return [root, index + (position > total ? 1 : 0)];
        }
        total += size;
      }
      return [root, root.childNodes.length];
    };
    const range = document.createRange();
    range.setStart(...point(start));
    range.setEnd(...point(end));
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
  }
  function dragPoint(x: number, y: number): number | undefined {
    if (!rich) return textareaPoint(plain, x, y);
    const point = caretPoint(x, y);
    if (!point || !root?.contains(point.node)) return;
    // 原子卡片只能落在前后边界，不能把标题 DOM 的位置当作全文偏移。
    const element =
      point.node instanceof HTMLElement ? point.node : point.node.parentElement;
    const card = element?.closest<HTMLElement>('[data-paste-id]');
    if (card) {
      const rect = card.getBoundingClientRect();
      const index = Array.from(root.childNodes).indexOf(card);
      return offset(root, index + (x >= rect.left + rect.width / 2 ? 1 : 0));
    }
    return offset(point.node, point.offset);
  }
  function dragMove(
    selected: { start: number; end: number },
    target: number,
    copy: boolean,
  ): void {
    if (!copy && target >= selected.start && target <= selected.end) return;
    record();
    const moved = moveParts(
      current,
      selected.start,
      selected.end,
      target,
      copy,
    );
    void apply(moved.parts, moved.start, moved.end);
    notice = copy ? '已复制选中文字' : '已移动选中文字';
  }
  function preview(text: string): string {
    return (
      text
        .trim()
        .split(/\r\n|\r|\n/)
        .find((line) => line.trim())
        ?.trim()
        .slice(0, 100) || '空文本'
    );
  }
  function count(text: string): string {
    return Array.from(text).length.toLocaleString();
  }
  /** 仅事务和外部替换重绘；组合输入期间交给 WebView，避免打断中文候选。 */
  function paint(): void {
    if (!root || !rich || composing) return;
    const fragment = document.createDocumentFragment();
    for (const part of current) {
      if (part.kind === 'text')
        fragment.append(document.createTextNode(part.text));
      else {
        const button = document.createElement('button');
        button.type = 'button';
        button.contentEditable = 'false';
        button.className = 'paste-card';
        button.dataset.pasteId = part.id;
        button.disabled = disabled;
        button.setAttribute(
          'aria-label',
          `还原粘贴文本：${preview(part.text)}，${count(part.text)} 字`,
        );
        button.title = '点击还原文字到输入框';
        const icon = document.createElement('span');
        icon.className = 'paste-icon';
        if (iconTemplate?.firstElementChild)
          icon.append(iconTemplate.firstElementChild.cloneNode(true));
        icon.setAttribute('aria-hidden', 'true');
        const body = document.createElement('span');
        body.className = 'paste-body';
        const title = document.createElement('span');
        title.className = 'paste-title';
        title.textContent = preview(part.text);
        const meta = document.createElement('span');
        meta.className = 'paste-meta';
        meta.textContent = `粘贴文本 · ${count(part.text)} 字`;
        body.append(title, meta);
        const arrow = document.createElement('span');
        arrow.textContent = '›';
        arrow.setAttribute('aria-hidden', 'true');
        button.append(icon, body, arrow);
        fragment.append(button);
      }
    }
    // 末尾文本节点提供可靠的卡片后光标落点，不加入零宽字符污染全文。
    fragment.append(document.createTextNode(''));
    root.replaceChildren(fragment);
  }
  $effect(() => {
    disabled;
    untrack(() => {
      root?.querySelectorAll('button').forEach((b) => (b.disabled = disabled));
    });
  });
  function snapshot() {
    return { parts: current.map((p) => ({ ...p })), ...selection() };
  }
  async function apply(
    next: DraftPart[],
    start: number,
    end = start,
    repaint = true,
  ): Promise<void> {
    current = normalizeParts(next);
    synced = draftText(current);
    value = synced;
    parts = current;
    oninput();
    if (current.some((part) => part.kind === 'paste')) rich = true;
    if (repaint) {
      await tick();
      paint();
      focus();
      setSelectionRange(start, end);
    }
  }
  function record(): void {
    undo.push(snapshot());
    if (undo.length > 100) undo.shift();
    redo = [];
  }
  function insert(text: string, fold = false): void {
    const { start, end } = selection();
    record();
    const part: DraftPart = fold
      ? { kind: 'paste', id: crypto.randomUUID(), text }
      : { kind: 'text', text };
    void apply(replaceParts(current, start, end, [part]), start + text.length);
    if (fold) notice = '已收纳粘贴文本，发送时保留全文';
  }
  function paste(event: ClipboardEvent): void {
    onpaste(event);
    if (event.defaultPrevented || disabled || composing) return;
    const text = event.clipboardData?.getData('text/plain') ?? '';
    if (!text) return;
    event.preventDefault();
    insert(text, allowFold && foldable(text));
  }
  function history(back: boolean): void {
    const source = back ? undo : redo;
    const next = source.pop();
    if (!next) return;
    (back ? redo : undo).push(snapshot());
    void apply(next.parts, next.start, next.end);
    notice = back ? '已撤销' : '已重做';
  }
  function keydown(event: KeyboardEvent): void {
    if (composing || event.isComposing || event.keyCode === 229) {
      onkeydown(event);
      return;
    }
    if (event.target instanceof HTMLButtonElement) {
      if (['Enter', ' '].includes(event.key)) {
        event.preventDefault();
        open(event.target.dataset.pasteId ?? '');
        return;
      }
      if (['ArrowLeft', 'ArrowRight'].includes(event.key)) {
        event.preventDefault();
        const id = event.target.dataset.pasteId;
        let position = 0;
        for (const part of current) {
          if (part.kind === 'paste' && part.id === id) {
            if (event.key === 'ArrowRight') position += part.text.length;
            break;
          }
          position += part.text.length;
        }
        focus();
        setSelectionRange(position, position);
        return;
      }
    }
    if (
      (event.ctrlKey || event.metaKey) &&
      !event.altKey &&
      ['z', 'y'].includes(event.key.toLowerCase())
    ) {
      event.preventDefault();
      history(event.key.toLowerCase() === 'z' && !event.shiftKey);
      return;
    }
    if (rich && ['Backspace', 'Delete'].includes(event.key)) {
      const { start, end } = selection();
      let position = 0;
      for (const part of current) {
        const next = position + part.text.length;
        if (
          part.kind === 'paste' &&
          start === end &&
          ((event.key === 'Backspace' && start === next) ||
            (event.key === 'Delete' && start === position))
        ) {
          event.preventDefault();
          setSelectionRange(position, next);
          notice = '已选中粘贴文本，再次删除可移除';
          return;
        }
        position = next;
      }
    }
    onkeydown(event);
  }
  function beforeinput(event: InputEvent): void {
    if (disabled) {
      event.preventDefault();
      return;
    }
    if (
      event.inputType === 'historyUndo' ||
      event.inputType === 'historyRedo'
    ) {
      event.preventDefault();
      history(event.inputType === 'historyUndo');
      return;
    }
    if (composing || event.isComposing) return;
    if (
      rich &&
      ['insertParagraph', 'insertLineBreak'].includes(event.inputType)
    ) {
      event.preventDefault();
      insert('\n');
      return;
    }
    if (rich && event.inputType.startsWith('delete')) {
      const { start, end } = selection();
      if (start !== end) {
        event.preventDefault();
        record();
        void apply(replaceParts(current, start, end, []), start);
        return;
      }
    }
    pendingInput = snapshot();
  }
  function readDOM(): DraftPart[] {
    const result: DraftPart[] = [];
    function visit(node: Node): void {
      if (node instanceof HTMLElement && node.dataset.pasteId) {
        const part = current.find(
          (p) => p.kind === 'paste' && p.id === node.dataset.pasteId,
        );
        if (part) result.push(part);
      } else if (node.nodeType === Node.TEXT_NODE)
        result.push({ kind: 'text', text: node.textContent ?? '' });
      else if (node.nodeName === 'BR')
        result.push({ kind: 'text', text: '\n' });
      else {
        for (const child of Array.from(node.childNodes)) visit(child);
      }
    }
    for (const child of Array.from(root.childNodes)) visit(child);
    return normalizeParts(result);
  }
  function input(): void {
    if (composing) return;
    const next = rich
      ? readDOM()
      : [{ kind: 'text' as const, text: plain.value }];
    if (draftText(next) === synced) {
      pendingInput = undefined;
      return;
    }
    undo.push(pendingInput ?? snapshot());
    if (undo.length > 100) undo.shift();
    redo = [];
    pendingInput = undefined;
    void apply(next, 0, 0, false);
  }
  function clipboard(event: ClipboardEvent, cut: boolean): void {
    if (!rich) return;
    const { start, end } = selection();
    if (start === end) return;
    event.preventDefault();
    event.clipboardData?.setData('text/plain', value.slice(start, end));
    if (cut && !disabled) {
      record();
      void apply(replaceParts(current, start, end, []), start);
    }
  }
  /** 以全文替换原子卡片；保持前后内容和插入位置，撤销可恢复原来的卡片。 */
  function open(id: string): void {
    if (disabled) return;
    let position = 0;
    for (const part of current) {
      position += part.text.length;
      if (part.kind === 'paste' && part.id === id) break;
    }
    record();
    void apply(
      current.map((part) =>
        part.kind === 'paste' && part.id === id
          ? { kind: 'text', text: part.text }
          : part,
      ),
      position,
    );
    notice = '已还原为文字';
  }
</script>

<span hidden bind:this={iconTemplate}><Icon name="copy" size={16} /></span>
{#if rich}
  <div
    bind:this={root}
    use:textDrag={{
      enabled: !disabled && !composing,
      context,
      value,
      selection,
      select: setSelectionRange,
      point: dragPoint,
      move: dragMove,
    }}
    class="draft-editor"
    data-composer-input
    contenteditable={!disabled}
    role="textbox"
    aria-label={label}
    aria-multiline="true"
    aria-disabled={disabled}
    aria-controls={controls}
    aria-activedescendant={activeDescendant}
    tabindex={disabled ? -1 : 0}
    data-placeholder={placeholder}
    onkeydown={keydown}
    onbeforeinput={beforeinput}
    oninput={input}
    onpaste={paste}
    oncopy={(e) => clipboard(e, false)}
    oncut={(e) => clipboard(e, true)}
    ondrop={(event) => {
      if (!event.dataTransfer?.files.length) {
        event.preventDefault();
        const text = event.dataTransfer?.getData('text/plain');
        if (text && !disabled) insert(text, allowFold && foldable(text));
      }
    }}
    onclick={(event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>(
        '[data-paste-id]',
      );
      if (button) open(button.dataset.pasteId!);
    }}
    oncompositionstart={() => {
      pendingInput = snapshot();
      composing = true;
      oncompositionstart();
    }}
    oncompositionend={() => {
      composing = false;
      input();
      oncompositionend();
    }}
  ></div>
{:else}
  <textarea
    bind:this={plain}
    use:textDrag={{
      enabled: !disabled && !composing,
      context,
      value,
      selection,
      select: setSelectionRange,
      point: dragPoint,
      move: dragMove,
    }}
    data-composer-input
    {value}
    rows="1"
    {placeholder}
    aria-label={label}
    aria-controls={controls}
    aria-activedescendant={activeDescendant}
    {disabled}
    onkeydown={keydown}
    onbeforeinput={beforeinput}
    oninput={input}
    onpaste={paste}
    oncompositionstart={() => {
      pendingInput = snapshot();
      composing = true;
      oncompositionstart();
    }}
    oncompositionend={() => {
      composing = false;
      input();
      oncompositionend();
    }}></textarea>
{/if}
{#if hasCards}<p class="paste-hint">点击还原文字 · 直接发送保留卡片</p>{/if}
{#if notice}<div
    class="paste-notice"
    class:sr-only={notice !== '已移除粘贴文本'}
    role="status"
  >
    {notice}{#if notice === '已移除粘贴文本'}<button
        type="button"
        {disabled}
        onclick={() => history(true)}>撤销</button
      >{/if}
  </div>{/if}

<style>
  .draft-editor {
    min-height: 40px;
    max-height: 200px;
    overflow-y: auto;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
    font-size: 16px;
    line-height: 1.7;
    padding: 0 3px;
    outline: none;
  }
  .draft-editor:empty::before {
    content: attr(data-placeholder);
    color: var(--muted);
    pointer-events: none;
  }
  .draft-editor :global(.paste-card) {
    display: inline-flex;
    align-items: center;
    vertical-align: middle;
    gap: 10px;
    width: 280px;
    max-width: calc(100% - 4px);
    min-height: 56px;
    margin: 3px 2px;
    padding: 8px 12px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--bg);
    color: var(--muted);
    text-align: left;
    white-space: normal;
    cursor: pointer;
    transition:
      background-color 100ms,
      border-color 100ms;
  }
  .draft-editor :global(.paste-card:hover:not(:disabled)) {
    background: var(--surface);
  }
  .draft-editor :global(.paste-card:focus-visible) {
    outline: 2px solid var(--accent);
    outline-offset: -3px;
  }
  .draft-editor :global(.paste-body) {
    display: flex;
    flex: 1;
    min-width: 0;
    flex-direction: column;
    gap: 2px;
  }
  .draft-editor :global(.paste-title) {
    color: var(--text);
    font-size: 14px;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .draft-editor :global(.paste-meta) {
    font-size: 12px;
  }
  .draft-editor :global(.paste-icon) {
    font-size: 18px;
  }
  .paste-hint,
  .paste-notice {
    margin: 6px 0 0;
    color: var(--muted);
    font-size: 12px;
  }
  @media (prefers-reduced-motion: reduce) {
    .draft-editor :global(.paste-card) {
      transition: none;
    }
  }
</style>
