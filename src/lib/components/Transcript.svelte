<!-- 动态高度虚拟列表：仅挂载可见消息；滚动跟随由用户意图控制，不由每个 token 强拉到底部。 -->
<script lang="ts">
  import { onMount, tick } from 'svelte';
  import {
    Virtualizer,
    elementScroll,
    observeElementOffset,
    observeElementRect,
    type VirtualItem,
  } from '@tanstack/virtual-core';
  import MessageView from './MessageView.svelte';
  import Icon from './Icon.svelte';
  import type { Message } from '../types';
  /** 分页由父门面负责，列表只保存滚动锚点；onload 为预览按需读取。 */
  let {
    messages,
    hasMore = false,
    loading = false,
    onolder,
    onfull,
    onload,
    onvisible,
    onerror,
  }: {
    messages: Message[];
    hasMore?: boolean;
    loading?: boolean;
    onolder: () => Promise<void>;
    onfull: (message: Message) => void;
    onload: (message: Message) => Promise<void>;
    onvisible: (ids: string[]) => void;
    onerror: (message: string) => void;
  } = $props();
  let viewport: HTMLDivElement;
  let virtual: Virtualizer<HTMLDivElement, HTMLElement> | undefined;
  let items = $state<VirtualItem[]>([]);
  let total = $state(0);
  let follow = $state(true);
  let frame = 0;
  let mounted = $state(false);
  /** 高度变化只请求一次帧更新；resize/Markdown 完成后也遵循用户的 follow 状态。 */
  function update(): void {
    if (!virtual) return;
    const visibleItems = virtual.getVirtualItems();
    items = visibleItems;
    onvisible(
      visibleItems
        .map((item) => messages[item.index]?.id)
        .filter((id): id is string => Boolean(id)),
    );
    total = virtual.getTotalSize();
    if (follow) {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() =>
        virtual?.scrollToIndex(Math.max(0, messages.length - 1), {
          align: 'end',
        }),
      );
    }
  }
  onMount(() => {
    virtual = new Virtualizer({
      count: messages.length,
      getScrollElement: () => viewport,
      estimateSize: () => 140,
      getItemKey: (index) => messages[index]?.id ?? index,
      overscan: 5,
      scrollToFn: elementScroll,
      observeElementOffset,
      observeElementRect,
      onChange: update,
    });
    const cleanup = virtual._didMount();
    virtual._willUpdate();
    mounted = true;
    update();
    return () => {
      cancelAnimationFrame(frame);
      cleanup();
    };
  });
  $effect(() => {
    const length = messages.length;
    const last = messages[length - 1];
    last?.text;
    last?.thinking;
    last?.status;
    if (!mounted || !virtual) return;
    virtual.setOptions({
      ...virtual.options,
      count: length,
      getItemKey: (index) => messages[index]?.id ?? index,
    });
    virtual._willUpdate();
    update();
  });
  /** TanStack 内部 ResizeObserver 负责动态测量，节点卸载后移除旧引用。 */
  function measure(node: HTMLElement) {
    virtual?.measureElement(node);
    return { destroy: () => virtual?.measureElement(null) };
  }
  /** 加载旧页时保留首个可见消息与内部偏移，不用新增条数猜测高度。 */
  async function older(): Promise<void> {
    if (!virtual || loading) return;
    follow = false;
    const anchor = virtual.getVirtualItems()[0];
    const id = anchor ? messages[anchor.index]?.id : undefined;
    const offset = anchor ? viewport.scrollTop - anchor.start : 0;
    await onolder();
    await tick();
    if (id) {
      const index = messages.findIndex((m) => m.id === id);
      if (index >= 0) {
        virtual.scrollToIndex(index, { align: 'start' });
        viewport.scrollTop += offset;
      }
    }
    update();
  }
  /** 用户滚回底部才重新启用跟随；上滚/触摸操作可立即取消。 */
  function scroll(): void {
    if (
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <=
      80
    )
      follow = true;
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions (独立滚动区域需要键盘焦点与 PageUp/Home；并非把正文伪装为按钮。) -->
<div
  class="transcript"
  bind:this={viewport}
  onscroll={scroll}
  onwheel={(event) => {
    if (event.deltaY < 0) follow = false;
  }}
  ontouchmove={() => {
    follow = false;
  }}
  onkeydown={(event) => {
    if (['PageUp', 'Home', 'ArrowUp'].includes(event.key)) follow = false;
  }}
  tabindex="0"
  role="region"
  aria-label="对话消息"
  aria-live="off"
>
  {#if hasMore}<div class="older-row">
      <button
        class="text-button"
        disabled={loading}
        onclick={() => {
          void older().catch((error) => onerror(String(error)));
        }}>{loading ? '正在加载…' : '加载更早消息'}</button
      >
    </div>{/if}
  <div class="virtual-space" style:height={`${total}px`}>
    {#each items as item (item.key)}
      {@const message = messages[item.index]}
      {#if message}<div
          class="virtual-item"
          data-index={item.index}
          style:transform={`translateY(${item.start}px)`}
          use:measure
        >
          <MessageView {message} {onfull} {onload} {onerror} />
        </div>{/if}
    {/each}
  </div>
</div>
{#if !follow}<button
    class="scroll-bottom icon-button"
    title="回到底部"
    aria-label="回到底部"
    onclick={() => {
      follow = true;
      update();
    }}><span class="rotate"><Icon name="arrow" size={18} /></span></button
  >{/if}
