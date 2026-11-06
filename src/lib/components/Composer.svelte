<!-- 输入器只有草稿与提交意图，不知道 RPC；组合输入、自动高度和发送模式在此收敛。 -->
<script lang="ts">
  import { onMount, tick, type Snippet } from 'svelte';
  import { isTauri, invoke } from '@tauri-apps/api/core';
  import Icon from './Icon.svelte';
  import DraftEditor from './DraftEditor.svelte';
  import type { DraftPart } from '../draft-parts';
  import DraftAttachments from './DraftAttachments.svelte';
  import {
    imageBudget,
    importBrowserFiles,
    type DraftAttachment,
    type ImportedFile,
  } from '../attachments';
  import { registerFileDrop } from '../file-drop';
  import { shouldSend } from '../state/reducer';
  import {
    categorizedCommands,
    commandCategories,
    commandCategory,
    commandSupport,
    type CommandCategory,
  } from '../commands';
  import type { Command, HistoryPage, Message } from '../types';
  import { imageLimit, imagesLimit } from '../images';
  import { errorMessage } from '../client';
  /** 运行中 Enter/发送直接引导当前任务，后续消息与停止使用独立按钮。 */
  let {
    value = $bindable(''),
    parts = $bindable<DraftPart[]>([]),
    attachments = $bindable<DraftAttachment[]>([]),
    active = true,
    disabled = false,
    running = false,
    submitting = false,
    commands = [],
    unavailableCommands = [],
    menu,
    controls,
    onchoose,
    onback,
    oncommand,
    onsend,
    onstop,
    historyKey = '',
    onhistory,
    onhistorytext,
  }: {
    historyKey?: string;
    onhistory?: (before?: number) => Promise<HistoryPage>;
    onhistorytext?: (message: Message) => Promise<string>;
    value?: string;
    parts?: DraftPart[];
    attachments?: DraftAttachment[];
    active?: boolean;
    disabled?: boolean;
    running?: boolean;
    submitting?: boolean;
    commands?: Command[];
    unavailableCommands?: string[];
    controls?: Snippet;
    menu?: {
      title: string;
      items: { name: string; description?: string }[];
      busy?: boolean;
      canBack?: boolean;
      error?: string;
    };
    onchoose?: (name: string) => void;
    onback?: () => void;
    oncommand?: (name: string) => boolean;
    onsend: (mode?: 'steer' | 'followUp') => void;
    onstop: () => void;
  } = $props();
  let textarea: DraftEditor;
  let picker: HTMLInputElement;
  let root: HTMLDivElement;
  let pendingImports = $state(0);
  let fileBusy = $derived(pendingImports > 0);
  let dragging = $state(false);
  let fileError = $state('');
  let importGeneration = 0;
  let importQueue = Promise.resolve();
  $effect(() => {
    historyKey;
    active;
    ++importGeneration;
    pendingImports = 0;
    dragging = false;
    fileError = '';
    importQueue = Promise.resolve();
    return () => {
      ++importGeneration;
    };
  });
  const canImport = () => active && !disabled && !submitting && !menu;
  /** 票据立即交给宿主消费；提交结果按批次顺序归并，并重新核对累计预算。 */
  function enqueueImport(
    operation: Promise<ImportedFile[]> | (() => Promise<ImportedFile[]>),
  ): void {
    const request = importGeneration;
    if (!pendingImports) fileError = '';
    ++pendingImports;
    // 即刻挂接 rejection，避免后面的批次先失败时产生未处理的 Promise。
    const early =
      typeof operation === 'function'
        ? undefined
        : operation.then(
            (items) => ({ items }),
            (cause) => ({ cause }),
          );
    importQueue = importQueue.then(async () => {
      if (request !== importGeneration) return;
      try {
        const result = early
          ? await early
          : { items: await (operation as () => Promise<ImportedFile[]>)() };
        if (request !== importGeneration) return;
        if ('cause' in result) throw result.cause;
        const accepted: DraftAttachment[] = [];
        const errors: string[] = [];
        const budget = imageBudget(attachments);
        for (const item of result.items) {
          if (item.kind === 'error') {
            errors.push(item.name + '：' + item.message);
            continue;
          }
          if (item.kind === 'image') {
            const bytes = imageBudget([item]).bytes;
            if (budget.count >= 8) {
              errors.push(
                (item.image.name ?? '图片') + '：每条消息最多添加 8 张图片。',
              );
              continue;
            }
            if (bytes > imageLimit || budget.bytes + bytes > imagesLimit) {
              errors.push(
                (item.image.name ?? '图片') +
                  '：超出图片大小限制（单张 10 MiB，总计 24 MiB）。',
              );
              continue;
            }
            budget.count++;
            budget.bytes += bytes;
          }
          accepted.push(item);
        }
        if (accepted.length) attachments = [...attachments, ...accepted];
        if (errors.length)
          fileError = [fileError, ...errors].filter(Boolean).join('\n');
      } catch (cause) {
        if (request === importGeneration)
          fileError = [fileError, errorMessage(cause)]
            .filter(Boolean)
            .join('\n');
      } finally {
        if (request === importGeneration) --pendingImports;
      }
    });
  }
  function addFiles(files: File[]): void {
    if (!canImport() || !files.length) return;
    enqueueImport(() => importBrowserFiles(files, attachments));
  }
  function chooseFiles(): void {
    if (!canImport() || fileBusy) return;
    if (!isTauri()) {
      picker.click();
      return;
    }
    enqueueImport(
      invoke<ImportedFile[]>('pick_files', {
        budget: imageBudget(attachments),
      }),
    );
  }
  function paste(event: ClipboardEvent): void {
    const files = Array.from(event.clipboardData?.files ?? []);
    if (files.length) {
      event.preventDefault();
      addFiles(files);
    }
  }
  onMount(() =>
    registerFileDrop({
      element: root,
      enabled: canImport,
      hover: (value) => {
        dragging = value;
      },
      drop: (dropId) =>
        enqueueImport(
          invoke<ImportedFile[]>('read_dropped_files', {
            dropId,
            budget: imageBudget(attachments),
          }),
        ),
      error: (message) => {
        fileError = message;
      },
    }),
  );
  let composing = false;
  let historyMessages: Message[] = [];
  let historyIndex = -1;
  let historyBefore = 0;
  let historyMore = false;
  let historyInitialized = false;
  let historyRequest = 0;
  let recalled = '';
  let historyBusy = $state(false);
  let historyError = $state('');
  /** 修改草稿或切换上下文后立即作废读取；迟到结果不能覆盖用户输入。 */
  function resetHistory(): void {
    ++historyRequest;
    historyMessages = [];
    historyIndex = -1;
    historyInitialized = false;
    recalled = '';
    historyBusy = false;
    historyError = '';
  }
  $effect(() => {
    historyKey;
    resetHistory();
  });
  $effect(() => {
    if (value !== recalled) resetHistory();
  });
  /** 历史按消息 ID 去重，保留重复发送的相同文本；更早页面仅在边界请求。 */
  async function browseHistory(direction: -1 | 1): Promise<void> {
    if (!onhistory || historyBusy) return;
    const request = ++historyRequest;
    const key = historyKey;
    const draft = value;
    const current = () =>
      request === historyRequest && key === historyKey && value === draft;
    historyBusy = true;
    historyError = '';
    try {
      if (!historyInitialized) {
        const page = await onhistory();
        if (!current()) return;
        historyMessages = page.messages;
        historyBefore = page.before;
        historyMore = page.hasMore;
        historyIndex = historyMessages.length;
        historyInitialized = true;
      }
      let index = historyIndex + direction;
      while (index < 0 && historyMore) {
        const page = await onhistory(historyBefore);
        if (!current()) return;
        const ids = new Set(historyMessages.map((message) => message.id));
        const earlier = page.messages.filter((message) => {
          if (ids.has(message.id)) return false;
          ids.add(message.id);
          return true;
        });
        historyMessages = [...earlier, ...historyMessages];
        historyIndex += earlier.length;
        index += earlier.length;
        historyBefore = page.before;
        historyMore = page.hasMore;
      }
      if (index < 0 || index > historyMessages.length) return;
      const message = historyMessages[index];
      const text = message
        ? await (onhistorytext?.(message) ?? Promise.resolve(message.text))
        : '';
      if (!current()) return;
      historyIndex = index;
      recalled = text;
      value = text;
      // 召回的斜杠文本供编辑，不能突然打开命令菜单抢走历史导航。
      dismissed = text;
      await tick();
      if (request !== historyRequest || key !== historyKey || value !== text)
        return;
      const position = direction === -1 ? 0 : text.length;
      textarea.setSelectionRange(position, position);
    } catch (cause) {
      if (current()) historyError = errorMessage(cause);
    } finally {
      if (request === historyRequest) historyBusy = false;
    }
  }
  let selected = $state(0);
  let dismissed = $state('');
  let query = $state('');
  const menuId = $props.id();
  let category = $state<CommandCategory | '全部'>('全部');
  let catalog = $derived(
    categorizedCommands(commands).filter(
      (command) => !unavailableCommands.includes(command.name),
    ),
  );
  let availableCategories = $derived(
    commandCategories.filter((group) =>
      catalog.some((command) => commandCategory(command) === group),
    ),
  );
  let searching = $derived(value.length > 1);
  function selectCategory(group: CommandCategory | '全部'): void {
    category = group;
    selected = 0;
    textarea.focus();
  }
  let matches = $derived(
    menu
      ? menu.items.filter((item) =>
          `${item.name} ${item.description ?? ''}`
            .toLowerCase()
            .includes(query.toLowerCase()),
        )
      : !disabled &&
          value.startsWith('/') &&
          !/\s/.test(value) &&
          dismissed !== value
        ? catalog.filter(
            (command) =>
              (searching ||
                category === '全部' ||
                commandCategory(command) === category) &&
              `${command.name} ${command.description ?? ''} ${commandCategory(command)}`
                .toLowerCase()
                .includes(value.slice(1).toLowerCase()),
          )
        : [],
  );
  $effect(() => {
    value;
    selected = 0;
    if (value === '/') category = '全部';
  });
  $effect(() => {
    menu?.title;
    query = '';
    selected = 0;
  });
  $effect(() => {
    query;
    selected = 0;
  });
  let windowStart = $derived(Math.max(0, selected - 20));
  $effect(() => {
    if (matches[selected])
      document
        .getElementById(`${menuId}-${selected}`)
        ?.scrollIntoView?.({ block: 'nearest' });
  });
  function complete(index: number, enter = false): void {
    if (fileBusy || disabled || submitting || !active) return;
    const command = matches[index];
    if (!command || menu?.busy) return;
    if (menu) {
      onchoose?.(command.name);
      return;
    }
    if (enter && !attachments.length && oncommand?.(command.name)) {
      textarea.focus();
      return;
    }
    value = `/${command.name} `;
    dismissed = '';
    textarea.focus();
  }
  async function back(): Promise<void> {
    if (menu?.canBack === false) return;
    onback?.();
    await tick();
    dismissed = value;
    textarea?.focus();
  }
  /** 模式在按钮与提示中明确表达；提交期间阻止重复请求。 */
  function submit(mode?: 'steer' | 'followUp'): void {
    if (menu) {
      complete(selected, true);
      return;
    }
    if (
      (!value.trim() && !attachments.length) ||
      !active ||
      disabled ||
      submitting ||
      fileBusy
    )
      return;
    onsend(mode ?? (running ? 'steer' : undefined));
  }
  /** IME 回车由浏览器确认候选；只有非组合输入才 preventDefault 并发送。 */
  function keydown(event: KeyboardEvent): void {
    if (composing || event.isComposing || event.keyCode === 229) return;
    if (menu && event.key === 'Escape') {
      event.preventDefault();
      void back();
      return;
    }
    if (menu?.busy) {
      if (['Enter', 'Tab'].includes(event.key)) event.preventDefault();
      return;
    }
    if (
      matches.length &&
      !event.shiftKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      if (event.key === 'Escape') {
        event.preventDefault();
        dismissed = value;
        return;
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        selected =
          (selected + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) %
          matches.length;
        return;
      }
      if (event.key === 'Tab' || event.key === 'Enter') {
        event.preventDefault();
        complete(selected, event.key === 'Enter');
        return;
      }
    }
    if (menu) {
      if (event.key === 'Enter' || event.key === 'Tab') event.preventDefault();
      return;
    }
    if (
      onhistory &&
      !disabled &&
      !submitting &&
      !event.shiftKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      textarea.selection().start === textarea.selection().end &&
      (value === '' || (historyInitialized && value === recalled))
    ) {
      const position = textarea.selection().start;
      // 只在首行/末行接管方向键，多行文本内部仍使用原生光标移动。
      const up =
        event.key === 'ArrowUp' && !value.slice(0, position).includes('\n');
      const down =
        event.key === 'ArrowDown' &&
        historyInitialized &&
        !value.slice(position).includes('\n');
      if (up || down) {
        event.preventDefault();
        void browseHistory(up ? -1 : 1);
        return;
      }
    }
    if (shouldSend(event, composing)) {
      event.preventDefault();
      submit();
    }
  }
</script>

<div
  bind:this={root}
  class="composer"
  class:dragging
  class:disabled
  role="group"
  aria-label="消息编辑器"
  ondragover={(event) => {
    if (event.dataTransfer?.types.includes('Files')) {
      event.preventDefault();
      if (canImport()) dragging = true;
    }
  }}
  ondragleave={(event) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null))
      dragging = false;
  }}
  ondrop={(event) => {
    dragging = false;
    if (event.dataTransfer?.files.length) {
      event.preventDefault();
      if (!isTauri()) addFiles(Array.from(event.dataTransfer.files));
    }
  }}
>
  {#if dragging}<div class="drop-hint" role="status">
      <Icon name="attachment" size={24} /><span>松开以添加文件</span>
    </div>{/if}
  <input
    bind:this={picker}
    class="file-picker"
    type="file"
    multiple
    aria-label="选择文件"
    onchange={(event) => {
      addFiles(Array.from(event.currentTarget.files ?? []));
      event.currentTarget.value = '';
    }}
  />
  {#if attachments.length}<DraftAttachments
      bind:attachments
      {historyKey}
      onempty={() => textarea.focus()}
    />{/if}
  {#if fileBusy}<p class="file-feedback" role="status">
      正在添加文件{pendingImports > 1 ? `（${pendingImports} 批）` : ''}…
    </p>{/if}
  {#if fileError}<p class="file-feedback file-error" role="alert">
      {fileError}
    </p>{/if}
  {#if matches.length || menu}<div
      class="slash-menu"
      role="listbox"
      id={menuId}
      aria-label={menu?.title ?? 'Pi 命令'}
    >
      {#if !menu}<div
          class="command-categories"
          role="group"
          aria-label="命令分类"
        >
          {#each ['全部', ...availableCategories] as group}<button
              type="button"
              class:chosen={category === group}
              aria-pressed={category === group}
              onmousedown={(event) => event.preventDefault()}
              onclick={() => selectCategory(group as CommandCategory | '全部')}
              >{group}</button
            >{/each}
        </div>{/if}
      {#if menu}<div class="inline-command-header">
          <button
            type="button"
            onkeydown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                void back();
              }
            }}
            onclick={() => {
              void back();
            }}
            disabled={menu.canBack === false}>← 返回</button
          ><strong>{menu.title}</strong>
        </div>
        {#if menu.error}<p role="alert">{menu.error}</p>{/if}
        {#if menu.busy}<p role="status">正在执行…</p>{/if}
      {/if}
      {#if menu && !matches.length}<p role="status">没有匹配项</p>{/if}
      {#each matches.slice(windowStart, windowStart + 40) as command, offset}
        {@const index = windowStart + offset}
        {#if !menu && 'source' in command && (offset === 0 || !('source' in matches[index - 1]) || commandCategory(command as Command) !== commandCategory(matches[index - 1] as Command))}<div
            class="command-group-label"
            role="presentation"
          >
            {commandCategory(command as Command)}
          </div>{/if}
        <button
          id={`${menuId}-${index}`}
          role="option"
          aria-selected={selected === index}
          class:active={selected === index}
          tabindex="-1"
          onpointermove={() => {
            selected = index;
          }}
          onmousedown={(event) => event.preventDefault()}
          disabled={menu?.busy}
          onclick={() => complete(index, true)}
          ><strong
            >{menu
              ? ''
              : '/'}{command.name}{#if !menu && 'source' in command && commandSupport(command as Command)}
              <span class="support-hint"
                >{commandSupport(command as Command)}</span
              >{/if}</strong
          ><small
            >{'argumentHint' in command && command.argumentHint
              ? `${command.argumentHint} · `
              : ''}{command.description ??
              ('source' in command ? command.source : '')}</small
          ></button
        >{/each}
      {#if windowStart + 40 < matches.length}<button
          type="button"
          disabled={menu?.busy}
          onclick={() => {
            selected = Math.min(matches.length - 1, windowStart + 40);
          }}>更多选项（共 {matches.length} 项）</button
        >{/if}
    </div>{/if}
  <DraftEditor
    bind:this={textarea}
    bind:value={
      () => (menu ? query : value),
      (text) => {
        if (menu) query = text;
        else value = text;
      }
    }
    bind:parts
    allowFold={!menu}
    context={`${historyKey}:${menu?.title ?? ''}`}
    placeholder={disabled
      ? '先选择项目文件夹，再开始对话'
      : running
        ? '补充要求或调整方向，引导当前任务'
        : '向 Pi 发送消息'}
    label={menu ? '搜索菜单' : '消息输入'}
    controls={matches.length ? menuId : undefined}
    activeDescendant={matches.length ? `${menuId}-${selected}` : undefined}
    oninput={() => {
      if (!menu) resetHistory();
      dismissed = '';
    }}
    {disabled}
    onpaste={paste}
    onkeydown={keydown}
    oncompositionstart={() => {
      composing = true;
    }}
    oncompositionend={() => {
      composing = false;
    }}
  />
  {#if historyError}<p role="alert">
      历史提示词读取失败：{historyError}，可再次按方向键重试。
    </p>{/if}
  {#if historyBusy}<p role="status">正在读取历史提示词…</p>{/if}
  <div class="composer-bottom">
    <div class="composer-options">
      <div class="composer-tools">
        {#if controls}{@render controls()}{/if}
        <button
          type="button"
          class="attachment-button"
          aria-label="添加文件"
          disabled={disabled || submitting || fileBusy || !!menu || !active}
          onclick={chooseFiles}
          title="添加文件：PNG、JPEG、WebP、GIF 作为图片发送，其他文件作为路径引用"
          ><Icon name="attachment" size={19} /></button
        >
      </div>
      <span class="composer-hint"
        >{!menu && /^\/compact(?:\s|$)/.test(value)
          ? '语法：/compact [可选压缩要求] · Enter 直接执行压缩'
          : running
            ? 'Enter 发送引导 · Shift + Enter 换行'
            : onhistory
              ? '↑ / ↓ 翻阅历史 · Shift + Enter 换行'
              : 'Shift + Enter 换行'}</span
      >
    </div>
    <div class="composer-actions">
      {#if running}
        <button
          class="text-button"
          title="排在当前任务完成后处理"
          disabled={disabled ||
            submitting ||
            fileBusy ||
            (!value.trim() && !attachments.length)}
          onclick={() => submit('followUp')}>完成后发送</button
        >
        <button
          class="send-button stop-button"
          aria-label="停止任务"
          title="停止任务"
          {disabled}
          onclick={onstop}><Icon name="stop" size={18} /></button
        >
      {/if}
      <button
        class="send-button"
        class:steer-button={running}
        aria-label={running ? '发送引导' : '发送消息'}
        title={running ? '发送引导，在下一个可处理节点生效' : '发送消息'}
        disabled={disabled ||
          (!menu && !value.trim() && !attachments.length) ||
          submitting ||
          fileBusy ||
          (!!menu && !matches.length)}
        onclick={() => submit()}
        >{#if running}<span>发送引导</span>{/if}<Icon
          name="arrow"
          size={19}
        /></button
      >
    </div>
  </div>
</div>

<style>
  .composer {
    position: relative;
  }
  .composer.dragging {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  .drop-hint {
    position: absolute;
    inset: 4px;
    z-index: 5;
    display: flex;
    gap: 10px;
    align-items: center;
    justify-content: center;
    border-radius: 12px;
    background: var(--input-surface);
    color: var(--accent);
    pointer-events: none;
  }
  .file-feedback {
    margin: 0 0 8px;
    font-size: 12px;
    color: var(--muted);
    white-space: pre-line;
    max-height: 96px;
    overflow-y: auto;
  }
  .file-error {
    color: var(--error);
  }
  /* 工具同行排列，提示另起一行；沿用模型控件的焦点顺序与主题配色。 */
  .composer-tools {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 4px;
    min-width: 0;
  }
  .attachment-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 32px;
    height: 32px;
    padding: 0;
    border: 1px solid transparent;
    border-radius: 9px;
    background: transparent;
    color: var(--muted);
  }
  .attachment-button:hover:not(:disabled) {
    color: var(--text);
    background: var(--surface);
    border-color: var(--border);
  }
  .attachment-button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .attachment-button:disabled {
    opacity: 0.4;
  }
  .file-picker {
    display: none;
  }
  .command-categories {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
    padding: 6px;
    border-bottom: 1px solid var(--border, #8883);
  }
  .command-categories button {
    width: auto;
    padding: 5px 9px;
    font-size: 12px;
    border-radius: 6px;
  }
  .command-categories button.chosen {
    background: var(--hover, #8882);
    font-weight: 600;
  }
  .command-group-label {
    padding: 10px 10px 4px;
    font-size: 11px;
    opacity: 0.65;
    font-weight: 600;
  }
  .inline-command-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px;
  }
  .inline-command-header button {
    width: auto;
  }
</style>
