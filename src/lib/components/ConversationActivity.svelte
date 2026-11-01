<script lang="ts">
  import type { ConversationActivity } from '../conversation-activity';
  let { activity }: { activity: ConversationActivity | null } = $props();
</script>

<!-- 容器随对话保留，阶段改变只更新内容；不定时播报、不抢焦点。 -->
<div class="conversation-activity" role="status" aria-atomic="true">
  {#if activity}
    <div
      class="activity-line"
      class:paused={activity.paused}
      class:stopping={activity.stopping}
    >
      <span class="activity-dots" aria-hidden="true"
        ><span></span><span></span><span></span></span
      >
      <span>{activity.label}</span>
    </div>
  {/if}
</div>

<style>
  .activity-line {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 36px;
    padding-block: 6px 12px;
    color: var(--muted);
    font-size: 13px;
    line-height: 20px;
  }
  .activity-dots {
    display: inline-flex;
    flex: 0 0 auto;
    gap: 4px;
    color: var(--accent);
  }
  .activity-dots span {
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: currentColor;
    animation: activity-fade 1.5s ease-in-out infinite;
  }
  .activity-dots span:nth-child(2) {
    animation-delay: 0.2s;
  }
  .activity-dots span:nth-child(3) {
    animation-delay: 0.4s;
  }
  .paused .activity-dots {
    color: var(--muted);
  }
  .paused .activity-dots span {
    animation: none;
  }
  .stopping,
  .stopping .activity-dots {
    color: var(--warning);
  }
  @keyframes activity-fade {
    0%,
    70%,
    100% {
      opacity: 0.35;
    }
    35% {
      opacity: 1;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .activity-dots span {
      animation: none;
    }
  }
</style>
