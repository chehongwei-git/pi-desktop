<script lang="ts">
  import { onMount, tick, type Snippet } from 'svelte';
  import Icon from './Icon.svelte';

  let {
    message,
    title = '消息提示',
    tone = 'info',
    dismissLabel = '关闭提示',
    duration = 0,
    ondismiss,
    actions,
  }: {
    message: string;
    title?: string;
    tone?: 'info' | 'success' | 'error' | 'warning';
    dismissLabel?: string;
    duration?: number;
    ondismiss: () => void;
    actions?: Snippet;
  } = $props();

  let card: HTMLDivElement;
  let expanded = $state(false);
  let hovered = $state(false);
  let focused = $state(false);
  let returnFocus: HTMLElement | null = null;
  const detailsId = $props.id();
  const long = $derived(message.length > 160 || message.includes('\n'));
  onMount(() => {
    returnFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
  });
  $effect(() => {
    // 更新消息时重新计时；带操作或重要状态的提示由调用方保持常驻。
    const current = message;
    if (!duration || hovered || focused || !current) return;
    const timer = setTimeout(ondismiss, duration);
    return () => clearTimeout(timer);
  });
  $effect(() => {
    message;
    expanded = false;
  });
  async function dismiss(): Promise<void> {
    const restore = card.contains(document.activeElement);
    ondismiss();
    await tick();
    if (restore && returnFocus?.isConnected && !returnFocus.closest('[inert]'))
      returnFocus.focus({ preventScroll: true });
  }
</script>

<div
  bind:this={card}
  class="message-notice"
  role="group"
  aria-label={title}
  class:error={tone === 'error'}
  class:warning={tone === 'warning'}
  onpointerenter={() => {
    hovered = true;
  }}
  onpointerleave={() => {
    hovered = false;
  }}
  onfocusin={() => {
    focused = true;
  }}
  onfocusout={(event) => {
    focused = card.contains(event.relatedTarget as Node);
  }}
>
  <span class="notice-icon" aria-hidden="true">
    <Icon
      name={tone === 'success' ? 'check' : tone === 'info' ? 'info' : 'warning'}
      size={18}
    />
  </span>
  <div class="notice-body">
    <div role={tone === 'error' ? 'alert' : 'status'} aria-atomic="true">
      <strong>{title}</strong>
      <p id={detailsId} class:collapsed={long && !expanded}>{message}</p>
    </div>
    {#if actions || long}
      <div class="notice-actions">
        {#if actions}{@render actions()}{/if}
        {#if long}
          <button
            class="text-button"
            aria-expanded={expanded}
            aria-controls={detailsId}
            onclick={() => {
              expanded = !expanded;
            }}
          >
            {expanded ? '收起详情' : '展开详情'}
          </button>
        {/if}
      </div>
    {/if}
  </div>
  <button
    class="icon-button notice-close"
    aria-label={dismissLabel}
    onclick={() => {
      void dismiss();
    }}
  >
    <Icon name="close" size={16} />
  </button>
</div>

<style>
  .message-notice {
    --notice-color: var(--accent);
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 8px;
    min-height: 38px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg);
    color: var(--text);
    box-shadow: none;
    pointer-events: auto;
    animation: notice-enter 160ms ease-out;
  }
  .error {
    --notice-color: var(--error);
  }
  .warning {
    --notice-color: #91651b;
  }
  :global(:root[data-theme='dark']) .warning {
    --notice-color: #e4bc75;
  }
  .notice-icon {
    display: grid;
    place-items: center;
    flex-shrink: 0;
    width: 24px;
    height: 24px;
    border-radius: 9px;
    color: var(--notice-color);
    background: color-mix(in srgb, var(--notice-color) 10%, var(--bg));
  }
  .notice-body {
    flex: 1;
    min-width: 0;
    padding-top: 0;
  }
  strong {
    /* 视觉标题由图标及无障碍组名表达，避免短提示重复占用一行。 */
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    font-size: 12px;
    font-weight: 600;
    line-height: 1.6;
  }
  p {
    margin: 0;
    font-size: 12px;
    line-height: 1.65;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    max-height: 25dvh;
    overflow-y: auto;
  }
  p.collapsed {
    display: -webkit-box;
    -webkit-line-clamp: 1;
    line-clamp: 1;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .notice-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin: 2px 0 0 -8px;
  }
  .notice-actions :global(button) {
    font-size: 12px;
    min-height: 30px;
    color: var(--notice-color);
  }
  .notice-close {
    flex-shrink: 0;
    color: var(--muted);
    margin: 0;
    min-width: 30px;
    min-height: 30px;
  }
  @keyframes notice-enter {
    from {
      opacity: 0;
      transform: translateY(-4px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .message-notice {
      animation: none;
    }
  }
</style>
