<!-- 三处会话列表共享打开、选中与置顶交互，按钮彼此独立以支持键盘操作。 -->
<script lang="ts">
  import type { SessionSummary } from '../types';
  import Icon from './Icon.svelte';
  let {
    session,
    active = false,
    pinned = false,
    busy = false,
    disabled = false,
    showProject = false,
    onopen,
    onpin,
  }: {
    session: SessionSummary;
    active?: boolean;
    pinned?: boolean;
    busy?: boolean;
    disabled?: boolean;
    showProject?: boolean;
    onopen: () => void;
    onpin: () => void;
  } = $props();
  const label = $derived(
    session.name || session.preview || session.timestamp || '新会话',
  );
</script>

<div class="session-row" class:active>
  <button
    class="history-item"
    class:active
    aria-current={active ? 'page' : undefined}
    title={session.warning ?? `${label}\n${session.cwd}`}
    {disabled}
    onclick={onopen}
  >
    <span class="session-text">
      <span>{label}</span>
      {#if showProject}<small
          >{session.cwd.split(/[\\/]/).filter(Boolean).pop() ||
            session.cwd}</small
        >{/if}
    </span>
    {#if session.warning}<span title={session.warning}>!</span>{/if}
  </button>
  <button
    class="icon-button session-pin"
    class:pinned
    aria-label={`${pinned ? '取消置顶' : '置顶'} ${label}`}
    aria-pressed={pinned}
    title={pinned ? '取消置顶' : '置顶会话'}
    disabled={busy}
    onclick={onpin}><Icon name="pin" size={14} /></button
  >
</div>
