<!-- 会话行的轻量状态图标：固定几何，运行只旋转弧线，减少动画时保留静态辨识。 -->
<script lang="ts">
  let { status, unread = false }: { status: string; unread?: boolean } =
    $props();
  const kind = $derived(
    status === '运行中'
      ? 'running'
      : status === '已完成'
        ? 'completed'
        : status === '失败'
          ? 'failed'
          : status === '排队中'
            ? 'queued'
            : status === '待你处理'
              ? 'waiting'
              : status === '停止中'
                ? 'stopped'
                : 'draft',
  );
</script>

<span
  class="session-status-icon"
  class:unread
  title={`${status}${unread ? ' · 有新回复' : ''}`}
  data-state={kind}
  aria-hidden="true"
>
  <svg
    width="17"
    height="17"
    viewBox="0 0 20 20"
    fill="none"
    stroke="currentColor"
    stroke-width="1.6"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    {#if kind === 'running'}
      <circle class="track" cx="10" cy="10" r="7.2" />
      <path class="orbit" d="M10 2.8a7.2 7.2 0 0 1 7.2 7.2" />
      <circle
        class="core"
        cx="10"
        cy="10"
        r="1.5"
        fill="currentColor"
        stroke="none"
      />
    {:else if kind === 'completed'}
      <circle class="wash" cx="10" cy="10" r="7.2" />
      <path d="m6.5 10 2.3 2.4 4.8-4.9" />
    {:else if kind === 'failed'}
      <circle class="wash" cx="10" cy="10" r="7.2" />
      <path d="M10 6.4v4.2" /><circle
        cx="10"
        cy="13.4"
        r=".85"
        fill="currentColor"
        stroke="none"
      />
    {:else if kind === 'queued'}
      <circle cx="10" cy="10" r="7.2" /><path d="M10 5.9v4.4l2.8 1.6" />
    {:else if kind === 'waiting'}
      <path
        class="wash"
        d="M5.5 3.4h9a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H10l-4.5 2.5v-2.5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2Z"
      />
      <path d="M10 6.5v2.4" /><circle
        cx="10"
        cy="11.4"
        r=".65"
        fill="currentColor"
        stroke="none"
      />
    {:else if kind === 'stopped'}
      <circle cx="10" cy="10" r="7.2" /><rect
        x="7.4"
        y="7.4"
        width="5.2"
        height="5.2"
        rx=".7"
        fill="currentColor"
        stroke="none"
      />
    {:else}
      <path d="m5 13.4-.5 2.1 2.1-.5L15 6.6 13.4 5 5 13.4ZM11.8 6.6l1.6 1.6" />
    {/if}
  </svg>
  {#if unread}<span class="unread-dot"></span>{/if}
</span>

<style>
  .session-status-icon {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    flex-shrink: 0;
    color: var(--muted);
  }
  [data-state='running'],
  [data-state='completed'] {
    color: var(--accent);
  }
  [data-state='failed'] {
    color: var(--error);
  }
  [data-state='waiting'] {
    color: var(--warning);
  }
  .track {
    opacity: 0.24;
  }
  .core {
    opacity: 0.7;
  }
  .wash {
    fill: currentColor;
    fill-opacity: 0.08;
    stroke-opacity: 0.65;
  }
  .orbit {
    transform-origin: 10px 10px;
    animation: session-orbit 1.2s linear infinite;
  }
  .unread-dot {
    position: absolute;
    top: 0;
    right: 0;
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: var(--accent);
    box-shadow: 0 0 0 1.5px var(--sidebar);
  }
  @keyframes session-orbit {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .orbit {
      animation: none;
    }
  }
</style>
