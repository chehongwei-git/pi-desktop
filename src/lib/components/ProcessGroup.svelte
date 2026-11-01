<script lang="ts">
  import { tick } from 'svelte';
  import type { Snippet } from 'svelte';
  import type { Message, ProcessInfo } from '../types';
  import { processDuration } from '../process-groups';
  import Icon from './Icon.svelte';
  let {
    id,
    messages,
    info,
    expanded,
    ontoggle,
    children,
  }: {
    id: string;
    messages: Message[];
    info?: ProcessInfo;
    expanded: boolean;
    ontoggle: () => void;
    children: Snippet;
  } = $props();
  let heading: HTMLButtonElement;
  let now = $state(Date.now());
  let running = $derived(
    info?.state === 'running' ||
      (!info &&
        messages.some((m) => ['streaming', 'running'].includes(m.status))),
  );
  let tools = $derived(messages.filter((m) => m.role === 'toolResult').length);
  let duration = $derived(processDuration(info, now));
  // 等待扩展回答时停止刷新；恢复、结束或卸载时重新管理定时器。
  $effect(() => {
    if (!running || info?.pausedAt != null) return;
    now = Date.now();
    const timer = setInterval(() => {
      now = Date.now();
    }, 1000);
    return () => clearInterval(timer);
  });
  async function toggle(): Promise<void> {
    const closing = expanded;
    ontoggle();
    await tick();
    if (closing) {
      heading.focus({ preventScroll: true });
      heading.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    }
  }
</script>

<section class="process-group" aria-label="处理过程">
  <button
    class="process-heading"
    bind:this={heading}
    aria-expanded={expanded}
    aria-controls={id}
    onclick={() => void toggle()}
  >
    <span class:open={expanded} class="chevron"
      ><Icon name="down" size={14} /></span
    >
    <span class="process-label"
      >{info?.state === 'stopped'
        ? '已停止'
        : info?.state === 'error'
          ? '未完成'
          : '处理过程'}</span
    >
    {#if tools}<span class="process-meta">· {tools} 次工具调用</span>{/if}
    {#if duration}<span class="process-meta"
        >· {running ? '已用时' : '耗时'} {duration}</span
      >{/if}
  </button>
  {#if expanded}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions (Escape 从详情内的按钮冒泡，收起后恢复入口焦点。) -->
    <div
      {id}
      class="process-content"
      onkeydown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          void toggle();
        }
      }}
      role="group"
      aria-label="处理详情"
    >
      {@render children()}
      <button class="text-button" onclick={() => void toggle()}
        >收起处理过程</button
      >
    </div>
  {/if}
  {#if !running && info?.state === 'stopped'}<small
      >任务已停止，尚未生成完整回答。</small
    >
  {:else if !running && info?.state === 'error'}<small class="error-text"
      >任务未完成，可展开查看详情。</small
    >{/if}
</section>

<style>
  .process-group {
    margin: 12px 0;
    min-width: 0;
  }
  .process-heading {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    padding: 8px 4px;
    background: transparent;
    border: 0;
    color: inherit;
    font-size: 13px;
    text-align: left;
    cursor: pointer;
    min-height: 36px;
  }
  /* 过程入口只负责详情导航；运行反馈统一在对话末尾展示。 */
  .process-heading:hover {
    background: var(--hover);
  }
  .process-meta {
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .chevron {
    display: inline-flex;
    transform: rotate(-90deg);
  }
  .chevron.open {
    transform: none;
  }
  .process-content {
    padding-left: 16px;
    border-left: 1px solid currentColor;
    margin-left: 10px;
  }
  small {
    display: block;
    margin: 4px;
  }
</style>
