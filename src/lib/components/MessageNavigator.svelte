<!-- 目录独立分页，不改变正文；仅主动选择条目时请求正文定位。 -->
<script lang="ts">
  import { tick } from 'svelte';
  import Icon from './Icon.svelte';
  import { messageSummary, navigationMessages } from '../message-navigation';
  import type { HistoryPage, Message } from '../types';
  let {
    messages,
    active,
    currentId,
    onhistory,
    onlocate,
    oncancel,
  }: {
    messages: Message[];
    active: boolean;
    currentId: string;
    onhistory: (before?: number) => Promise<HistoryPage>;
    onlocate: (id: string) => Promise<void>;
    oncancel: () => void;
  } = $props();
  let open = $state(false);
  let query = $state('');
  let history = $state<Message[]>([]);
  let before = $state<number>();
  let more = $state(false);
  let busy = $state(false);
  let locating = $state(false);
  let error = $state('');
  let trigger: HTMLButtonElement;
  let search = $state<HTMLInputElement>();
  let list = $state<HTMLDivElement>();
  let root: HTMLElement;
  let revision = 0;
  let entries = $derived(navigationMessages(history, messages));
  let filtered = $derived(
    entries
      .map((message, index) => ({
        message,
        index,
        summary: messageSummary(message),
      }))
      .filter((item) =>
        item.summary
          .toLocaleLowerCase()
          .includes(query.trim().toLocaleLowerCase()),
      ),
  );

  /** 隐藏会话立即作废请求；旧请求的 finally 不能清除新请求状态。 */
  $effect(() => {
    if (!active) {
      revision++;
      busy = false;
      locating = false;
      oncancel();
    }
  });
  async function load(initial = false): Promise<void> {
    if (busy || locating || !active) return;
    const request = ++revision;
    busy = true;
    error = '';
    try {
      const page = await onhistory(initial ? undefined : before);
      if (request !== revision || !active) return;
      if (
        !initial &&
        page.hasMore &&
        before !== undefined &&
        page.before >= before
      )
        throw new Error('历史游标未前进，请重试');
      // 当前页直接取响应式消息，避免排队占位被权威消息替换后残留重复项。
      history = initial ? [] : navigationMessages(page.messages, history);
      before = page.before;
      more = page.hasMore;
    } catch (cause) {
      if (request === revision && active) error = String(cause);
    } finally {
      if (request === revision) busy = false;
    }
  }
  async function toggle(): Promise<void> {
    if (open) return close();
    open = true;
    await tick();
    search?.focus({ preventScroll: true });
    if (before === undefined) await load(true);
    await tick();
    const selected = list?.querySelector<HTMLElement>(
      '[aria-current="location"]',
    );
    // 只调整目录自己的滚动，不能带动正文或窗口。
    if (selected && list)
      list.scrollTop =
        selected.offsetTop - list.offsetTop - list.clientHeight / 2;
  }
  function close(): void {
    revision++;
    oncancel();
    busy = false;
    locating = false;
    open = false;
    trigger?.focus({ preventScroll: true });
  }
  async function locate(id: string): Promise<void> {
    if (busy || locating) return;
    const request = ++revision;
    locating = true;
    error = '';
    try {
      await onlocate(id);
      if (
        request === revision &&
        active &&
        root.getBoundingClientRect().width < 540
      )
        open = false;
    } catch (cause) {
      if (request === revision && active) error = String(cause);
    } finally {
      if (request === revision) locating = false;
    }
  }
</script>

<div class="navigator-root" bind:this={root}>
  <div class="navigator-rail">
    <button
      class="icon-button"
      bind:this={trigger}
      aria-label="我的消息"
      title="我的消息"
      aria-expanded={open}
      onclick={() => void toggle()}><Icon name="bookmark" size={18} /></button
    >
  </div>
  {#if open}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions (Escape 由目录内所有控件冒泡处理。) -->
    <nav
      class="message-navigator"
      aria-label="我的消息目录"
      onkeydown={(event) => {
        if (event.key === 'Escape' && !event.isComposing) {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      }}
    >
      <header>
        <strong>我的消息</strong><button
          class="icon-button"
          aria-label="收起消息目录"
          onclick={close}><Icon name="close" size={16} /></button
        >
      </header>
      <label class="navigator-search"
        ><Icon name="search" size={15} /><input
          bind:this={search}
          bind:value={query}
          aria-label="搜索已加载消息摘要"
          placeholder="搜索消息摘要…"
        /></label
      >
      <p class="navigator-count">
        {more ? '已加载' : '共'}
        {entries.length} 条 · {more ? '搜索已加载摘要' : '当前会话'}
      </p>
      <div class="navigator-list" bind:this={list}>
        {#each filtered as item (item.message.id)}
          <button
            class="navigator-item"
            aria-current={currentId === item.message.id
              ? 'location'
              : undefined}
            disabled={locating || busy}
            onclick={() => void locate(item.message.id)}
          >
            <span class="navigator-number"
              >{String(item.index + 1).padStart(2, '0')}</span
            ><span class="navigator-copy"
              ><span class="navigator-summary">{item.summary}</span
              >{#if item.message.delivery}<small
                  >{item.message.delivery.mode === 'steer'
                    ? '引导消息 · 等待处理'
                    : '后续消息 · 等待处理'}</small
                >{/if}</span
            >
          </button>
        {:else}<p class="navigator-empty">
            {query ? '已加载摘要中没有匹配消息' : '暂无已发送消息'}
          </p>{/each}
      </div>
      <footer>
        {#if error}<p class="error-text" role="alert">{error}</p>{/if}
        {#if locating}<span role="status">正在定位历史消息…</span><button
            class="text-button"
            onclick={() => {
              revision++;
              oncancel();
              locating = false;
            }}>取消定位</button
          >
        {:else if busy}<span role="status">正在加载消息目录…</span>
        {:else if more || error}<button
            class="text-button"
            onclick={() => void load(before === undefined)}
            >{error ? '重试加载目录' : '加载更早消息'}</button
          >
        {:else}<span>已到最早记录</span>{/if}
      </footer>
    </nav>
  {/if}
</div>

<style>
  .navigator-root {
    position: absolute;
    inset: 0;
    pointer-events: none;
    container-type: inline-size;
    z-index: 5;
  }
  .navigator-rail {
    position: absolute;
    inset-block: 0;
    inset-inline-end: 0;
    width: 36px;
    border-inline-start: 1px solid var(--border);
    background: var(--bg);
    pointer-events: auto;
    padding-top: 10px;
    display: flex;
    justify-content: center;
    align-items: flex-start;
  }
  .navigator-rail button {
    width: 32px;
    height: 36px;
    color: var(--muted);
  }
  .navigator-rail button[aria-expanded='true'] {
    color: var(--accent);
    background: var(--accent-soft);
  }
  .message-navigator {
    position: absolute;
    inset-block: 0;
    inset-inline-end: 36px;
    width: min(280px, calc(100% - 36px));
    background: var(--bg);
    border-inline-start: 1px solid var(--border);
    box-shadow: -8px 0 24px #0000000a;
    pointer-events: auto;
    display: flex;
    flex-direction: column;
    padding: 12px;
    gap: 10px;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 13px;
  }
  .navigator-search {
    display: flex;
    align-items: center;
    gap: 6px;
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 7px 8px;
    color: var(--muted);
  }
  input {
    min-width: 0;
    width: 100%;
    border: 0;
    padding: 0;
    background: transparent;
    font-size: 12px;
  }
  .navigator-count,
  footer,
  .navigator-empty {
    color: var(--muted);
    font-size: 12px;
    line-height: 1.6;
    margin: 0;
  }
  .navigator-list {
    flex: 1;
    min-height: 0;
    overflow: auto;
    overscroll-behavior: contain;
    position: relative;
  }
  .navigator-item {
    display: flex;
    gap: 10px;
    width: 100%;
    min-height: 48px;
    padding: 10px 8px;
    border: 0;
    border-inline-start: 2px solid transparent;
    border-radius: 6px;
    background: transparent;
    color: var(--text);
    text-align: start;
    margin-bottom: 3px;
  }
  .navigator-item:hover {
    background: var(--hover);
  }
  .navigator-item[aria-current] {
    border-inline-start-color: var(--accent);
    background: var(--accent-soft);
  }
  .navigator-number {
    color: var(--muted);
    font-size: 11px;
    line-height: 20px;
    font-variant-numeric: tabular-nums;
  }
  .navigator-copy {
    min-width: 0;
  }
  .navigator-summary {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    overflow-wrap: anywhere;
    font-size: 13px;
    line-height: 20px;
  }
  small {
    display: block;
    font-size: 11px;
    color: var(--muted);
    margin-top: 4px;
  }
  .navigator-empty {
    padding: 16px 6px;
  }
  footer {
    border-top: 1px solid var(--border);
    padding-top: 8px;
  }
  footer p {
    margin: 0 0 6px;
    overflow-wrap: anywhere;
  }
  @container (max-width: 540px) {
    .message-navigator {
      inset-inline-start: 0;
      width: auto;
      border-inline-start: 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .navigator-item,
    .navigator-rail button {
      transition: none;
    }
  }
</style>
