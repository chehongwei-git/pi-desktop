<!-- 普通文档流保留已读节点；只在历史前插时恢复一次阅读锚点。 -->
<script lang="ts">
  import { getContext, onMount, tick } from 'svelte';
  import { reviewKey, type ReviewLayoutState } from '../review-layout.svelte';
  import MessageView from './MessageView.svelte';
  import type { MessageEdit } from '../message-edit';
  import ProcessGroup from './ProcessGroup.svelte';
  import ConversationActivity from './ConversationActivity.svelte';
  import type { ConversationActivity as Activity } from '../conversation-activity';
  import { isPlanComplete, processRows } from '../process-groups';
  import PlanMessage from './PlanMessage.svelte';
  import TextPanel from './TextPanel.svelte';
  import ChangePanel from './ChangePanel.svelte';
  import Icon from './Icon.svelte';
  import type { ContentPage, Message, MessageTextPart } from '../types';
  let {
    messages,
    edit,
    editUnavailable,
    onedit,
    oncancelEdit,
    onresend,
    registerChange,
    active = true,
    scrollState = { top: 0, follow: true },
    activity = null,
    resumeFollow = 0,
    hasMore = false,
    loading = false,
    onolder,
    onfull,
    onload,
    onvisible,
    onerror,
    oncommit,
    toolViews,
    ontoggletool,
    read,
  }: {
    messages: Message[];
    edit?: MessageEdit | null;
    editUnavailable?: string;
    onedit?: (message: Message) => void;
    oncancelEdit?: () => void;
    onresend?: () => void;
    /** 输入区文件列表复用本视图详情区域；卸载后撤销入口，避免悬挂回调。 */
    registerChange?: (
      open:
        ((message: Message, trigger: HTMLButtonElement) => void) | undefined,
    ) => void;
    active?: boolean;
    /** 被缓存视图卸载后仍能恢复阅读位置。 */
    scrollState?: {
      top: number;
      follow: boolean;
      changeId?: string;
      textTarget?: { messageId: string; partId: string; top: number };
    };
    /** 活动提示属于列表内容，复用底部跟随且不干扰上翻阅读。 */
    activity?: Activity | null;
    /** 消息提交成功或确认扩展操作时恢复跟随；普通进度更新不能打断阅读。 */
    resumeFollow?: number;
    hasMore?: boolean;
    loading?: boolean;
    /** 请求结束、提交历史前调用，避免用网络请求开始时的旧位置恢复。 */
    onolder: (beforeInsert: () => void) => Promise<void>;
    onfull: (message: Message) => void;
    onload: (message: Message) => Promise<void>;
    onvisible: (ids: string[]) => void;
    onerror: (message: string) => void;
    /** 同会话重连提交前捕获最新阅读锚点；卸载时解除回调。 */
    oncommit?: (handler: (() => () => void) | undefined) => void;
    toolViews: Record<string, Record<string, boolean>>;
    ontoggletool: (id: string, section: string) => void;
    read: (id: string, offset: number) => Promise<ContentPage>;
  } = $props();
  const review = getContext<ReviewLayoutState | undefined>(reviewKey);
  // symbol 不会被深层响应式代理替换，保证重复更新与移除匹配同一所有者。
  const reviewOwner = Symbol('transcript-review');
  const mountPanel =
    review?.mount ?? ((_node: HTMLElement) => ({ destroy: () => {} }));
  $effect(() => {
    review?.update(
      reviewOwner,
      active && panelOpen,
      change?.id,
      (restoreFocus = true) =>
        void showChange(undefined, undefined, restoreFocus),
    );
  });
  let rows = $derived(processRows(messages));
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
  let reconciling = false;
  let alive = true;
  let frame = 0;
  let lastScrollTop = 0;
  let lastScrollHeight = 0;
  let lastClientHeight = 0;
  let touchY = 0;
  let change = $state<Message>();
  let textTarget = $state<{ messageId: string; partId: string; top: number }>();
  let textPart = $derived(
    messages
      .find((message) => message.id === textTarget?.messageId)
      ?.textParts?.find((part) => part.id === textTarget?.partId),
  );
  let panelOpen = $derived(!!change || !!textPart);
  /** 普通正文展开只补偿本次布局；底部收起回到入口，避免落在下一条消息。 */
  async function layout(
    update: () => void,
    trigger?: HTMLElement,
  ): Promise<void> {
    pauseFollow();
    const saved = anchor();
    update();
    await tick();
    if (!alive || !viewport) return;
    if (trigger?.isConnected) {
      trigger.focus({ preventScroll: true });
      trigger.scrollIntoView({ block: 'nearest' });
    } else if (saved?.node.isConnected)
      viewport.scrollTop += saved.node.getBoundingClientRect().top - saved.top;
    lastScrollTop = viewport.scrollTop;
  }
  async function showText(
    message: Message,
    part: MessageTextPart,
    trigger: HTMLButtonElement,
  ): Promise<void> {
    if (textTarget?.messageId === message.id && textTarget.partId === part.id) {
      trigger
        .closest('.transcript-workspace')
        ?.querySelector<HTMLElement>('.text-detail-panel button:last-child')
        ?.focus();
      return;
    }
    changeTrigger = trigger;
    await layout(() => {
      change = undefined;
      scrollState.changeId = undefined;
      textTarget = { messageId: message.id, partId: part.id, top: 0 };
      scrollState.textTarget = textTarget;
    });
  }
  let changeTrigger: HTMLButtonElement | undefined;
  /** 只在侧栏开关引发布局变化时恢复一次锚点，不干预后续阅读。 */
  async function showChange(
    message?: Message,
    trigger?: HTMLButtonElement,
    restoreFocus = true,
  ): Promise<void> {
    pauseFollow();
    const saved = anchor();
    change = message;
    textTarget = undefined;
    scrollState.textTarget = undefined;
    scrollState.changeId = message?.id;
    if (trigger) changeTrigger = trigger;
    await tick();
    if (!alive || !viewport) return;
    if (saved?.node.isConnected)
      viewport.scrollTop += saved.node.getBoundingClientRect().top - saved.top;
    lastScrollTop = viewport.scrollTop;
    if (!message && restoreFocus) {
      // 文件列表收起再展开会重建按钮，按稳定路径找回入口，避免焦点落到已卸载节点。
      const layoutRoot = viewport.closest('.review-layout');
      const replacement = [
        ...(layoutRoot?.querySelectorAll<HTMLButtonElement>(
          '.review-conversation .changes-file',
        ) ?? []),
      ].find((node) => node.title === changeTrigger?.title);
      const fallback = layoutRoot?.querySelector<HTMLButtonElement>(
        '.review-conversation .changes-toggle',
      );
      const trigger =
        changeTrigger?.isConnected &&
        !changeTrigger.closest('.review-mobile-files')
          ? changeTrigger
          : (replacement ?? fallback ?? viewport);
      trigger.focus({ preventScroll: true });
    }
  }

  function update(): void {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      if (!alive || !viewport || !active) return;
      if (follow && !pending && !reconciling) {
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
    // 同组历史可能插入既有折叠区内部，以实际消息或入口作为锚点。
    for (const node of content.querySelectorAll<HTMLElement>(
      '[data-message-id], .process-heading',
    )) {
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
    if (!alive || !viewport || !active) return;
    if (!error && viewport.scrollTop <= 200 && hasMore && !loading && !pending)
      void older();
  }
  function scroll(): void {
    if (!alive || !viewport || !active) return;
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
    scrollState.top = top;
    scrollState.follow = follow;
    checkOlder();
  }
  onMount(() => {
    mounted = true;
    registerChange?.((message, trigger) => void showChange(message, trigger));
    oncommit?.(() => {
      if (!active) return () => {};
      const saved = anchor();
      const id = saved?.node.dataset.messageId;
      const top = viewport.scrollTop;
      reconciling = true;
      return () => {
        void tick().then(() => {
          if (!alive) return;
          if (active) {
            const node = saved?.node.isConnected
              ? saved.node
              : [
                  ...content.querySelectorAll<HTMLElement>('[data-message-id]'),
                ].find((item) => item.dataset.messageId === id);
            if (node && saved)
              viewport.scrollTop +=
                node.getBoundingClientRect().top - saved.top;
            else viewport.scrollTop = top;
            lastScrollTop = viewport.scrollTop;
            scrollState.top = viewport.scrollTop;
            if (change)
              change = messages.find((message) => message.id === change?.id);
          }
          reconciling = false;
          update();
        });
      };
    });
    textTarget = scrollState.textTarget;
    if (scrollState.changeId)
      change = messages.find((message) => message.id === scrollState.changeId);
    const observer = new IntersectionObserver(checkOlder, {
      root: viewport,
      rootMargin: '200px 0px 0px',
    });
    observer.observe(sentinel);
    // 仅底部跟随需要观察内容总高度，不再给每条消息安装测量器。
    const resize = new ResizeObserver(update);
    resize.observe(content);
    resize.observe(viewport);
    viewport.scrollTop = scrollState.top;
    follow = scrollState.follow;
    update();
    return () => {
      alive = false;
      registerChange?.(undefined);
      review?.remove(reviewOwner);
      oncommit?.(undefined);
      onvisible([]);
      observer.disconnect();
      resize.disconnect();
      cancelAnimationFrame(frame);
    };
  });
  $effect(() => {
    if (active && mounted) {
      viewport.scrollTop = scrollState.top;
      follow = scrollState.follow;
      update();
    }
  });
  let followRevision: number | undefined;
  $effect(() => {
    const revision = resumeFollow;
    if (followRevision === undefined) {
      followRevision = revision;
      return;
    }
    if (followRevision !== revision) {
      followRevision = revision;
      follow = true;
      scrollState.follow = true;
      if (mounted) update();
    }
  });
  $effect(() => {
    // 普通列表的所有节点都仍在使用，禁止正文缓存淘汰导致已读内容突然缩短。
    onvisible(messages.map((message) => message.id));
    if (mounted) update();
  });
</script>

<div class="transcript-workspace" class:has-change={panelOpen && !review}>
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
      {#snippet renderMessage(message: Message)}
        <div class="message-item" data-message-id={message.id}>
          {#if isPlanComplete(message)}
            <PlanMessage
              {message}
              {read}
              {onerror}
              {toolViews}
              ontoggletool={(id, section) => {
                pauseFollow();
                ontoggletool(id, section);
              }}
            />
          {:else}
            <MessageView
              {message}
              {edit}
              {editUnavailable}
              editLocked={!!edit}
              {onedit}
              {oncancelEdit}
              {onresend}
              selectedPart={textTarget?.messageId === message.id
                ? textTarget.partId
                : undefined}
              ontext={(message, part, trigger) =>
                void showText(message, part, trigger)}
              onlayout={(update, trigger) => void layout(update, trigger)}
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
          {/if}
        </div>
      {/snippet}
      {#each rows as row (row.id)}
        {#if row.kind === 'message'}
          {@render renderMessage(row.message)}
        {:else}
          <div class="message-item" data-process-id={row.id}>
            <ProcessGroup
              id={row.id}
              messages={row.messages}
              info={row.info}
              expanded={toolViews[row.id]?.process ?? false}
              ontoggle={() => {
                pauseFollow();
                ontoggletool(row.id, 'process');
              }}
            >
              {#each row.messages as message (message.id)}
                {@render renderMessage(message)}
              {/each}
            </ProcessGroup>
          </div>
        {/if}
      {/each}
      <ConversationActivity {activity} />
    </div>
  </div>
  {#if panelOpen}
    <div class="review-panel-content" hidden={!active} use:mountPanel>
      {#if textPart && textTarget}
        {#key `${textTarget.messageId}:${textPart.id}:${textPart.contentRef}`}
          <TextPanel
            part={textPart}
            {read}
            bind:position={textTarget.top}
            onclose={() => void showChange()}
          />
        {/key}
      {:else if change}
        {#key `${change.id}:${change.tool?.diffRef ?? change.tool?.writeRef}`}
          <ChangePanel
            message={change}
            {read}
            onclose={() => void showChange()}
          />
        {/key}
      {/if}
    </div>
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
