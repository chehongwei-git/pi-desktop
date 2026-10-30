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
  import type { ContentPage, Message } from '../types';
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
    toolViews,
    ontoggletool,
    read,
  }: {
    messages: Message[];
    hasMore?: boolean;
    loading?: boolean;
    onolder: () => Promise<void>;
    onfull: (message: Message) => void;
    onload: (message: Message) => Promise<void>;
    onvisible: (ids: string[]) => void;
    onerror: (message: string) => void;
    toolViews: Record<string, Record<string, boolean>>;
    ontoggletool: (id: string, section: string) => void;
    read: (id: string, offset: number) => Promise<ContentPage>;
  } = $props();
  let viewport: HTMLDivElement;
  let virtual: Virtualizer<HTMLDivElement, HTMLElement> | undefined;
  let items = $state<VirtualItem[]>([]);
  let total = $state(0);
  let follow = $state(true);
  let frame = 0;
  let lastScrollTop = 0;
  let touchY = 0;
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
      frame = requestAnimationFrame(() => {
        if (follow)
          virtual?.scrollToIndex(Math.max(0, messages.length - 1), {
            align: 'end',
          });
      });
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
    pauseFollow();
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
  /** WebView/Chromium 对嵌套横向代码滚动区可能锁定滚轮；在纵向边界显式传给对话。 */
  function wheel(node: HTMLElement) {
    const handle = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.deltaY < 0) pauseFollow();
      const code = (event.target as Element).closest<HTMLElement>(
        '.tool-code, .markdown pre',
      );
      if (
        !code ||
        !node.contains(code) ||
        !event.deltaY ||
        Math.abs(event.deltaX) > Math.abs(event.deltaY)
      )
        return;
      const delta =
        event.deltaY *
        (event.deltaMode === 1
          ? 21
          : event.deltaMode === 2
            ? node.clientHeight
            : 1);
      const atBoundary =
        delta < 0
          ? code.scrollTop <= 1
          : code.scrollHeight - code.clientHeight - code.scrollTop <= 1;
      if (atBoundary) {
        event.preventDefault();
        node.scrollTop += delta;
      }
    };
    node.addEventListener('wheel', handle, { passive: false });
    return { destroy: () => node.removeEventListener('wheel', handle) };
  }
  /** 用户操作立即取消队列和虚拟列表中尚未完成的定位，避免争夺滚动位置。 */
  function pauseFollow(): void {
    follow = false;
    cancelAnimationFrame(frame);
    virtual?.cancelScroll();
    lastScrollTop = viewport.scrollTop;
  }
  /** 只有向下真正滚到底部才恢复跟随；上滚后仍靠近底部不能触发。 */
  function scroll(): void {
    const top = viewport.scrollTop;
    if (
      !follow &&
      top > lastScrollTop &&
      viewport.scrollHeight - top - viewport.clientHeight <= 2
    )
      follow = true;
    lastScrollTop = top;
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions (独立滚动区域需要键盘焦点与 PageUp/Home；并非把正文伪装为按钮。) -->
<div
  class="transcript"
  bind:this={viewport}
  onscroll={scroll}
  use:wheel
  ontouchstart={(event) => {
    touchY = event.touches[0]?.clientY ?? 0;
  }}
  ontouchmove={(event) => {
    const nextY = event.touches[0]?.clientY ?? touchY;
    if (nextY > touchY) pauseFollow();
    touchY = nextY;
  }}
  onpointerdown={(event) => {
    // 原生滚动条拖动也需要中止正在执行的底部定位。
    if (event.target === viewport) pauseFollow();
  }}
  onkeydown={(event) => {
    if (['PageUp', 'Home', 'ArrowUp'].includes(event.key)) pauseFollow();
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
          <MessageView
            {message}
            {onfull}
            {onload}
            {onerror}
            {toolViews}
            {read}
            ontoggletool={(id, section) => {
              pauseFollow();
              ontoggletool(id, section);
            }}
          />
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
