<!-- 普通文档流保留已读节点；只在历史前插时恢复一次阅读锚点。 -->
<script lang="ts">
  import { onMount, tick } from 'svelte';
  import MessageView from './MessageView.svelte';
  import ChangePanel from './ChangePanel.svelte';
  import Icon from './Icon.svelte';
  import type { ContentPage, Message } from '../types';
  let {
    messages,
    resumeFollow = 0,
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
    /** 用户确认扩展操作时恢复跟随；普通进度更新不能打断阅读。 */
    resumeFollow?: number;
    hasMore?: boolean;
    loading?: boolean;
    /** 请求结束、提交历史前调用，避免用网络请求开始时的旧位置恢复。 */
    onolder: (beforeInsert: () => void) => Promise<void>;
    onfull: (message: Message) => void;
    onload: (message: Message) => Promise<void>;
    onvisible: (ids: string[]) => void;
    onerror: (message: string) => void;
    toolViews: Record<string, Record<string, boolean>>;
    ontoggletool: (id: string, section: string) => void;
    read: (id: string, offset: number) => Promise<ContentPage>;
  } = $props();
  let viewport: HTMLDivElement;
  let content: HTMLDivElement;
  let sentinel: HTMLDivElement;
  let follow = $state(true);
  let atBottom = $state(true);
  /** 滚动位置可能含小数像素，使用与浏览器取整相容的底部容差。 */
  function isAtBottom(): boolean {
    return (
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 2
    );
  }
  let pending = $state(false);
  let error = $state('');
  let mounted = false;
  let alive = true;
  let frame = 0;
  let lastScrollTop = 0;
  let lastScrollHeight = 0;
  let lastClientHeight = 0;
  let touchY = 0;
  let change = $state<Message>();
  let changeTrigger: HTMLButtonElement | undefined;
  /** 只在侧栏开关引发布局变化时恢复一次锚点，不干预后续阅读。 */
  async function showChange(
    message?: Message,
    trigger?: HTMLButtonElement,
  ): Promise<void> {
    pauseFollow();
    const saved = anchor();
    change = message;
    if (trigger) changeTrigger = trigger;
    await tick();
    if (!alive || !viewport) return;
    if (saved?.node.isConnected)
      viewport.scrollTop += saved.node.getBoundingClientRect().top - saved.top;
    lastScrollTop = viewport.scrollTop;
    if (!message && changeTrigger?.isConnected)
      changeTrigger.focus({ preventScroll: true });
  }

  function update(): void {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      if (!alive || !viewport) return;
      if (follow && !pending) {
        viewport.scrollTop = viewport.scrollHeight;
        lastScrollTop = viewport.scrollTop;
      }
      // 暂停期间不能提前覆盖位置，否则真实下滚事件会丢失方向信息。
      atBottom = isAtBottom();
      lastScrollHeight = viewport.scrollHeight;
      lastClientHeight = viewport.clientHeight;
      checkOlder();
    });
  }
  function pauseFollow(): void {
    follow = false;
    cancelAnimationFrame(frame);
  }
  /** 只扫描到首个可见节点；已加载历史不回收，也不持续测量消息高度。 */
  function anchor(): { node: HTMLElement; top: number } | undefined {
    const top = viewport.getBoundingClientRect().top;
    for (const node of content.children) {
      const rect = node.getBoundingClientRect();
      if (rect.bottom > top)
        return { node: node as HTMLElement, top: rect.top };
    }
  }
  async function older(): Promise<void> {
    if (!alive || pending || loading || !hasMore) return;
    pending = true;
    error = '';
    const wasFollowing = follow;
    let saved: ReturnType<typeof anchor>;
    const previousFirst = messages[0]?.id;
    try {
      await onolder(() => {
        if (alive) saved = anchor();
      });
      await tick();
      if (!alive) return;
      if (saved?.node.isConnected)
        viewport.scrollTop +=
          saved.node.getBoundingClientRect().top - saved.top;
      // 短页填满视口后允许后续上翻；首次挂载仍以最新消息为起点。
      if (wasFollowing && follow) viewport.scrollTop = viewport.scrollHeight;
      if (hasMore && messages[0]?.id === previousFirst)
        throw new Error('历史加载未前进，请重试');
    } catch (cause) {
      if (alive) error = String(cause);
    } finally {
      if (alive) {
        pending = false;
        lastScrollTop = viewport.scrollTop;
        update();
      }
    }
  }
  function checkOlder(): void {
    if (!alive || !viewport) return;
    if (!error && viewport.scrollTop <= 200 && hasMore && !loading && !pending)
      void older();
  }
  function scroll(): void {
    if (!alive || !viewport) return;
    const top = viewport.scrollTop;
    atBottom = isAtBottom();
    // 操作区收起会使浏览器夹紧 scrollTop；布局变化本身不代表用户上翻。
    const sameLayout =
      viewport.scrollHeight === lastScrollHeight &&
      viewport.clientHeight === lastClientHeight;
    if (top < lastScrollTop && sameLayout) pauseFollow();
    else if (!pending && atBottom) follow = true;
    lastScrollTop = top;
    lastScrollHeight = viewport.scrollHeight;
    lastClientHeight = viewport.clientHeight;
    checkOlder();
  }
  onMount(() => {
    mounted = true;
    const observer = new IntersectionObserver(checkOlder, {
      root: viewport,
      rootMargin: '200px 0px 0px',
    });
    observer.observe(sentinel);
    // 仅底部跟随需要观察内容总高度，不再给每条消息安装测量器。
    const resize = new ResizeObserver(update);
    resize.observe(content);
    resize.observe(viewport);
    update();
    return () => {
      alive = false;
      observer.disconnect();
      resize.disconnect();
      cancelAnimationFrame(frame);
    };
  });
  $effect(() => {
    resumeFollow;
    follow = true;
    if (mounted) update();
  });
  $effect(() => {
    // 普通列表的所有节点都仍在使用，禁止正文缓存淘汰导致已读内容突然缩短。
    onvisible(messages.map((message) => message.id));
    if (mounted) update();
  });
</script>

<div class="transcript-workspace" class:has-change={!!change}>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions (独立滚动区域支持键盘阅读。) -->
  <div
    class="transcript"
    bind:this={viewport}
    onscroll={scroll}
    onwheel={(event) => {
      if (event.deltaY < 0) pauseFollow();
      else if (event.deltaY > 0 && !pending && isAtBottom()) {
        // 到底后的滚轮可能不再产生 scroll 事件，仍应允许恢复跟随。
        follow = true;
        update();
      }
    }}
    ontouchstart={(event) => {
      touchY = event.touches[0]?.clientY ?? 0;
    }}
    ontouchmove={(event) => {
      const next = event.touches[0]?.clientY ?? touchY;
      if (next > touchY) pauseFollow();
      touchY = next;
    }}
    onkeydown={(event) => {
      if (['PageUp', 'Home', 'ArrowUp'].includes(event.key)) pauseFollow();
    }}
    tabindex="0"
    role="region"
    aria-label="对话消息"
    aria-live="off"
  >
    <div class="older-row" bind:this={sentinel}>
      {#if error}<span role="alert">{error}</span>
        <button class="text-button" onclick={() => void older()}
          >重试加载历史</button
        >
      {:else}<span role="status"
          >{pending || loading
            ? '正在加载更早消息…'
            : hasMore
              ? '向上滚动加载更早消息'
              : '已到最早记录'}</span
        >{/if}
    </div>
    <div class="message-list" bind:this={content}>
      {#each messages as message (message.id)}
        <div class="message-item" data-message-id={message.id}>
          <MessageView
            {message}
            onchange={(message, trigger) => {
              void showChange(message, trigger);
            }}
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
        </div>
      {/each}
    </div>
  </div>
  {#if change}
    {#key `${change.id}:${change.tool?.diffRef ?? change.tool?.writeRef}`}
      <ChangePanel message={change} {read} onclose={() => void showChange()} />
    {/key}
  {/if}
  {#if !follow && !atBottom}<button
      class="scroll-bottom icon-button"
      title="回到底部"
      aria-label="回到底部"
      onclick={() => {
        follow = true;
        update();
      }}><span class="rotate"><Icon name="arrow" size={18} /></span></button
    >{/if}
</div>

<style>
  /* 箭头始终贴近正文底部，不依赖输入器或 Plan 操作区的动态高度。 */
  .transcript-workspace {
    position: relative;
    /* 将箭头与正文限制在输入区下层，避免挡住向上展开的模型菜单。 */
    z-index: 0;
  }
  .scroll-bottom {
    bottom: 16px;
  }
</style>
