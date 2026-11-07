<!-- 文件清单只占左列；选中状态取自实际审阅内容，关闭后不遗留高亮。 -->
<script lang="ts">
  import { getContext, tick, untrack } from 'svelte';
  import Icon from './Icon.svelte';
  import { reviewKey, type ReviewLayoutState } from '../review-layout.svelte';
  import type { Message, TurnChanges } from '../types';
  let {
    turns,
    error = '',
    expandedInitially = false,
    onretry,
    onselect,
  }: {
    turns: TurnChanges[];
    error?: string;
    expandedInitially?: boolean;
    onretry: () => void;
    onselect: (message: Message, trigger: HTMLButtonElement) => void;
  } = $props();
  const review = getContext<ReviewLayoutState | undefined>(reviewKey);
  let expanded = $state(untrack(() => expandedInitially));
  let selected = $state('');
  let lastOpened = $state('');
  let menu = $state(false);
  let info = $state(false);
  let root = $state<HTMLElement>();
  let trigger = $state<HTMLButtonElement>();
  let roundTrigger = $state<HTMLButtonElement>();
  let turn = $derived(turns.find((item) => item.id === selected) ?? turns[0]);
  let index = $derived(turns.findIndex((item) => item.id === turn?.id));
  let added = $derived(
    turn?.files.reduce((sum, file) => sum + (file.added ?? 0), 0) ?? 0,
  );
  let removed = $derived(
    turn?.files.reduce((sum, file) => sum + (file.removed ?? 0), 0) ?? 0,
  );
  let current = $derived(review ? review.current?.id : lastOpened);
  let incomplete = $derived(
    turn?.warnings.some((warning) =>
      /未比较|不完整|无法读取|超限/.test(warning),
    ) ?? false,
  );
  function id(file: TurnChanges['files'][number]): string {
    return `turn:${turn?.id}:${file.path}`;
  }
  function open(
    file: TurnChanges['files'][number],
    button: HTMLButtonElement,
  ): void {
    if (!turn) return;
    selected = turn.id;
    lastOpened = id(file);
    onselect(
      {
        id: lastOpened,
        role: 'toolResult',
        text: '',
        thinking: '',
        contentRef: null,
        status: 'done',
        name: null,
        tool: {
          callId: turn.id,
          name: 'edit',
          path: file.path,
          diffRef: file.contentRef,
          addedLines: file.added,
          removedLines: file.removed,
        },
        reviewTitle: turn.title,
      },
      button,
    );
  }
  async function toggleMenu(): Promise<void> {
    menu = !menu;
    if (menu) {
      await tick();
      root
        ?.querySelector<HTMLButtonElement>('.round-option[aria-pressed="true"]')
        ?.focus();
    }
  }
  function menuKeys(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.stopPropagation();
      menu = false;
      roundTrigger?.focus();
      return;
    }
    const items = [
      ...(root?.querySelectorAll<HTMLButtonElement>('.round-option') ?? []),
    ];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : event.key === 'ArrowDown'
            ? (at + 1) % items.length
            : event.key === 'ArrowUp'
              ? (at - 1 + items.length) % items.length
              : -1;
    if (next >= 0) {
      event.preventDefault();
      items[next]?.focus();
    }
  }
</script>

<svelte:window
  onpointerdown={(event) => {
    if (!root?.contains(event.target as Node)) menu = false;
  }}
  onblur={() => (menu = false)}
/>
{#if turn || error}
  <section class="turn-changes" aria-label="每轮代码变更" bind:this={root}>
    <div class="changes-summary">
      <button
        class="changes-toggle"
        bind:this={trigger}
        aria-expanded={expanded}
        onclick={() => (expanded = !expanded)}
      >
        <span class="chevron" class:expanded
          ><Icon name="down" size={14} /></span
        ><strong>代码变更</strong><span class="file-count"
          >{turn?.files.length ?? 0}</span
        >
      </button>
      {#if turn?.files.length}<span class="summary-counts"
          ><span class="changes-added">+{added}</span><span
            class="changes-removed">−{removed}</span
          ></span
        >{/if}
      <div class="changes-actions">
        {#if incomplete}<span
            class="round-hint"
            title="部分文件未纳入，查看采集范围与说明">部分文件未纳入</span
          >{/if}
        {#if selected && turns[0]?.id !== selected}<span class="round-hint"
            >历史</span
          >{/if}
        <button
          class="scope-button icon-button"
          aria-label="采集范围与说明"
          aria-expanded={info}
          onclick={() => (info = !info)}><Icon name="info" size={14} /></button
        >
        {#if turns.length}<button
            class="round-trigger"
            bind:this={roundTrigger}
            aria-label="选择变更轮次"
            aria-expanded={menu}
            onclick={() => void toggleMenu()}
            >{index <= 0 ? '最近一轮' : `前 ${index} 轮`}<Icon
              name="down"
              size={12}
            /></button
          >{/if}
      </div>
    </div>
    {#if menu}
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions (原生按钮承载选项语义与焦点，容器只代理方向键。) -->
      <div
        class="round-menu"
        role="region"
        aria-label="变更轮次"
        onkeydown={menuKeys}
        onfocusout={(event) => {
          if (
            event.relatedTarget &&
            !root?.contains(event.relatedTarget as Node)
          )
            menu = false;
        }}
      >
        <div class="round-heading">选择轮次</div>
        {#each turns as item, i (item.id)}<button
            class="round-option"
            aria-pressed={turn?.id === item.id}
            onclick={() => {
              if (review?.current?.id?.startsWith('turn:'))
                review.current.close();
              selected = item.id;
              lastOpened = '';
              menu = false;
              roundTrigger?.focus();
            }}
            ><span
              ><strong>{i === 0 ? '最近一轮' : `前 ${i} 轮`}</strong><small
                >{item.title}</small
              ></span
            ><span class="round-meta"
              >{item.files.length} 个文件{#if item.id === turn?.id}<Icon
                  name="check"
                  size={14}
                />{/if}</span
            ></button
          >{/each}
      </div>
    {/if}
    {#if info}<div class="changes-info">
        <strong>采集范围</strong>{#each turn?.warnings ?? [] as warning}<p>
            {warning}
          </p>{/each}
        <p>保留最近 10 轮；旧会话可从处理过程查看单次变更。</p>
      </div>{/if}
    {#if expanded}
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions (Escape 收起文件区并恢复入口。) -->
      <div
        class="changes-list"
        role="region"
        aria-label="变更文件"
        onkeydown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            expanded = false;
            trigger?.focus();
          }
        }}
      >
        {#if error}<p class="changes-message" role="alert">
            {error}
            <button class="text-button" onclick={onretry}>重试读取变更</button>
          </p>{/if}
        {#if turn}
          {#if turn.state !== 'done'}<p class="changes-message" role="status">
              {turn.state === 'error'
                ? '任务未完成，以下为已保存的修改'
                : '任务已停止，以下为已保存的修改'}
            </p>{/if}
          {#each turn.files as file (file.path)}
            <button
              class="changes-file"
              class:selected={current === id(file)}
              aria-pressed={current === id(file)}
              onclick={(event) => open(file, event.currentTarget)}
              title={file.path}
            >
              <span class="file-icon"><Icon name="file" size={15} /></span>
              <strong class="file-name">{file.path.split('/').at(-1)}</strong
              ><span class="file-directory"
                >{file.path.includes('/')
                  ? file.path.slice(0, file.path.lastIndexOf('/'))
                  : ''}</span
              >
              <span
                class="file-kind"
                aria-label={file.kind === 'added'
                  ? '新增'
                  : file.kind === 'deleted'
                    ? '删除'
                    : '修改'}
                >{file.kind === 'added'
                  ? 'A'
                  : file.kind === 'deleted'
                    ? 'D'
                    : 'M'}</span
              >
              {#if file.binary}<span class="file-stats">二进制</span
                >{:else}<span class="file-stats"
                  ><span class="changes-added">+{file.added}</span><span
                    class="changes-removed">−{file.removed}</span
                  ></span
                >{/if}
            </button>
          {:else}<p class="changes-message">
              本轮没有检测到可展示的文件变更。
            </p>{/each}
        {/if}
      </div>
    {/if}
  </section>
{/if}

<style>
  .turn-changes {
    container-type: inline-size;
    position: relative;
    margin-bottom: 8px;
    font-size: 12px;
    color: var(--muted);
    border-top: 1px solid var(--border);
  }
  .changes-summary {
    display: flex;
    align-items: center;
    gap: 12px;
    height: 38px;
    min-width: 0;
  }
  button {
    font: inherit;
  }
  .changes-toggle,
  .round-trigger {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    border: 0;
    background: transparent;
    color: inherit;
    padding: 5px 3px;
    white-space: nowrap;
  }
  .changes-toggle strong {
    color: var(--text);
    font-weight: 550;
    font-size: 13px;
  }
  .chevron {
    display: flex;
    transform: rotate(-90deg);
  }
  .chevron.expanded {
    transform: none;
  }
  .file-count {
    font-size: 11px;
    padding: 1px 5px;
    border-radius: 5px;
    background: var(--surface);
    font-variant-numeric: tabular-nums;
  }
  .summary-counts,
  .file-stats {
    display: inline-flex;
    gap: 8px;
    font-variant-numeric: tabular-nums;
  }
  .changes-actions {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .scope-button {
    width: 26px;
    height: 26px;
    min-width: 26px;
    padding: 5px;
    color: var(--muted);
  }
  .round-trigger {
    border-radius: 6px;
    padding: 5px 7px;
  }
  .round-trigger:hover,
  .round-trigger[aria-expanded='true'] {
    background: var(--hover);
    color: var(--text);
  }
  .round-hint {
    font-size: 11px;
  }
  .changes-list {
    max-height: min(184px, 22vh);
    overflow: auto;
    overscroll-behavior: contain;
    padding-bottom: 4px;
    scrollbar-width: thin;
  }
  .changes-file {
    width: 100%;
    height: 35px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 9px;
    border: 0;
    border-inline-start: 2px solid transparent;
    border-radius: 5px;
    background: transparent;
    color: inherit;
    text-align: start;
  }
  .changes-file:hover {
    background: var(--surface);
  }
  .changes-file.selected {
    background: var(--hover);
    border-inline-start-color: var(--accent);
  }
  .file-icon {
    display: flex;
    flex: none;
  }
  .file-name {
    color: var(--text);
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .file-directory {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 11px;
  }
  .file-kind {
    margin-left: auto;
    font:
      10px ui-monospace,
      monospace;
    opacity: 0.8;
  }
  .file-stats {
    flex: none;
    min-width: 64px;
    justify-content: flex-end;
    font-size: 11px;
  }
  .changes-added {
    color: var(--diff-added);
  }
  .changes-removed {
    color: var(--diff-removed);
  }
  .changes-message,
  .changes-info {
    margin: 0;
    padding: 8px 10px;
    line-height: 1.6;
    overflow-wrap: anywhere;
  }
  .changes-info {
    max-height: 140px;
    overflow: auto;
    background: var(--surface);
    border-radius: 6px;
    margin-bottom: 5px;
  }
  .changes-info p {
    margin: 5px 0;
  }
  .round-menu {
    position: absolute;
    right: 0;
    bottom: calc(100% + 5px);
    z-index: 6;
    width: min(330px, 100%);
    max-height: min(320px, 45vh);
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--bg);
    box-shadow: 0 8px 28px #0002;
    padding: 5px;
  }
  .round-heading {
    padding: 6px 9px;
    font-size: 11px;
  }
  .round-option {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 10px;
    text-align: start;
    border: 0;
    background: transparent;
    color: var(--text);
    padding: 9px;
    border-radius: 6px;
  }
  .round-option:hover,
  .round-option[aria-pressed='true'] {
    background: var(--surface);
  }
  .round-option > span:first-child {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .round-option strong {
    font-weight: 500;
  }
  .round-option small {
    color: var(--muted);
    overflow-wrap: anywhere;
    line-height: 1.5;
  }
  .round-meta {
    display: flex;
    align-items: center;
    gap: 7px;
    color: var(--muted);
    font-size: 11px;
    white-space: nowrap;
  }
  @media (max-height: 650px) {
    .changes-list {
      max-height: 100px;
    }
  }
  @container (max-width: 420px) {
    .summary-counts,
    .round-hint {
      display: none;
    }
    .changes-summary {
      gap: 5px;
    }
    .file-directory {
      max-width: 22%;
    }
  }
  @media (max-width: 600px) {
    .summary-counts,
    .round-hint {
      display: none;
    }
    .file-directory {
      max-width: 22%;
    }
  }
</style>
