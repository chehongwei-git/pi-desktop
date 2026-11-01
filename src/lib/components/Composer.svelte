<!-- 输入器只有草稿与提交意图，不知道 RPC；组合输入、自动高度和发送模式在此收敛。 -->
<script lang="ts">
  import { tick, type Snippet } from 'svelte';
  import Icon from './Icon.svelte';
  import ImageAttachments from './ImageAttachments.svelte';
  import { shouldSend } from '../state/reducer';
  import {
    categorizedCommands,
    commandCategories,
    commandCategory,
    commandSupport,
    type CommandCategory,
  } from '../commands';
  import type { Command, HistoryPage, Message, MessageImage } from '../types';
  import { imageAccept, readImages } from '../images';
  import { errorMessage } from '../client';
  /** 运行中 Enter/发送直接引导当前任务，后续消息与停止使用独立按钮。 */
  let {
    value = $bindable(''),
    images = $bindable<MessageImage[]>([]),
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
    images?: MessageImage[];
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
  let textarea: HTMLTextAreaElement;
  let picker: HTMLInputElement;
  let imageBusy = $state(false);
  let dragging = $state(false);
  let imageError = $state('');
  let imageRequest = 0;
  $effect(() => {
    historyKey;
    ++imageRequest;
    imageBusy = false;
    dragging = false;
    imageError = '';
  });
  /** 切换会话后作废异步读取；附件失败不影响原有草稿。 */
  async function addImages(files: File[]): Promise<void> {
    if (disabled || submitting || menu || imageBusy || !files.length) return;
    const request = ++imageRequest;
    imageBusy = true;
    imageError = '';
    try {
      const added = await readImages(files, images);
      if (request === imageRequest) images = [...images, ...added];
    } catch (cause) {
      if (request === imageRequest) imageError = errorMessage(cause);
    } finally {
      if (request === imageRequest) imageBusy = false;
    }
  }
  function paste(event: ClipboardEvent): void {
    const files = Array.from(event.clipboardData?.files ?? []);
    if (files.length) {
      event.preventDefault();
      void addImages(files);
    }
  }
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
    const command = matches[index];
    if (!command || menu?.busy) return;
    if (menu) {
      onchoose?.(command.name);
      return;
    }
    if (enter && !images.length && oncommand?.(command.name)) {
      textarea.focus();
      return;
    }
    value = `/${command.name} `;
    dismissed = '';
    textarea.focus();
  }
  $effect(() => {
    value;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
    }
  });
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
      (!value.trim() && !images.length) ||
      disabled ||
      submitting ||
      imageBusy
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
      textarea.selectionStart === textarea.selectionEnd &&
      (value === '' || (historyInitialized && value === recalled))
    ) {
      const position = textarea.selectionStart;
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
  class="composer"
  class:disabled
  role="group"
  aria-label="消息编辑器"
  ondragover={(event) => {
    if (event.dataTransfer?.types.includes('Files')) {
      event.preventDefault();
      if (!disabled && !submitting && !menu && !imageBusy) dragging = true;
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
      void addImages(Array.from(event.dataTransfer.files));
    }
  }}
>
  {#if dragging}<p role="status">松开以添加图片</p>{/if}
  <input
    bind:this={picker}
    class="image-picker"
    type="file"
    accept={imageAccept}
    multiple
    aria-label="选择图片文件"
    onchange={(event) => {
      void addImages(Array.from(event.currentTarget.files ?? []));
      event.currentTarget.value = '';
    }}
  />
  {#if images.length}<ImageAttachments
      bind:images
      {historyKey}
      onempty={() => textarea.focus()}
    />{/if}
  {#if imageBusy}<p role="status">正在读取图片…</p>{/if}
  {#if imageError}<p role="alert">{imageError}</p>{/if}
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
  <textarea
    bind:this={textarea}
    value={menu ? query : value}
    rows="1"
    placeholder={disabled
      ? '先选择项目文件夹，再开始对话'
      : running
        ? '补充要求或调整方向，引导当前任务'
        : '向 Pi 发送消息'}
    aria-label={menu ? '搜索菜单' : '消息输入'}
    aria-controls={matches.length ? menuId : undefined}
    aria-activedescendant={matches.length ? `${menuId}-${selected}` : undefined}
    oninput={(event) => {
      if (menu) query = event.currentTarget.value;
      else {
        resetHistory();
        value = event.currentTarget.value;
      }
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
    }}></textarea>
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
          class="image-button"
          aria-label="添加图片"
          disabled={disabled || submitting || imageBusy || !!menu}
          onclick={() => picker.click()}
          title="添加图片，也可粘贴截图或拖入图片"
          ><Icon name="image" size={19} /></button
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
            imageBusy ||
            (!value.trim() && !images.length)}
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
          (!menu && !value.trim() && !images.length) ||
          submitting ||
          imageBusy ||
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
  /* 工具同行排列，提示另起一行；沿用模型控件的焦点顺序与主题配色。 */
  .composer-tools {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 4px;
    min-width: 0;
  }
  .image-button {
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
  .image-button:hover:not(:disabled) {
    color: var(--text);
    background: var(--surface);
    border-color: var(--border);
  }
  .image-button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .image-button:disabled {
    opacity: 0.4;
  }
  .image-picker {
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
