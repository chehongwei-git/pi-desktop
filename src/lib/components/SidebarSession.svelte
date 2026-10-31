<!-- 三处会话列表共享打开、选中与置顶交互，按钮彼此独立以支持键盘操作。 -->
<script lang="ts">
  import { tick } from 'svelte';
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
    onpin: () => void | Promise<void>;
  } = $props();
  /** 取消置顶可能移除当前行；仅在原焦点仍无归属时恢复到相邻会话。 */
  async function togglePin(event: MouseEvent): Promise<void> {
    const button = event.currentTarget as HTMLButtonElement;
    const region = button.closest('section');
    const rows = [...(region?.querySelectorAll('.session-row') ?? [])];
    const index = rows.indexOf(button.closest('.session-row')!);
    await onpin();
    await tick();
    if (
      !button.isConnected &&
      (!document.activeElement || document.activeElement === document.body)
    ) {
      const remaining =
        region?.querySelectorAll<HTMLButtonElement>('.history-item');
      (
        remaining?.[Math.min(index, remaining.length - 1)] ??
        region?.querySelector<HTMLButtonElement>('button')
      )?.focus({ preventScroll: true });
    }
  }
  const label = $derived(
    session.name || session.preview || session.timestamp || '新会话',
  );
</script>

<div class="session-row" class:active>
  <button
    class="history-item"
    data-sidebar-kind="session"
    data-sidebar-path={session.path}
    data-sidebar-label={label}
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
    onclick={(event) => {
      void togglePin(event);
    }}><Icon name="pin" size={14} /></button
  >
  <button
    class="icon-button sidebar-more"
    data-sidebar-more
    aria-haspopup="menu"
    aria-label={`会话操作 ${label}`}
    title="更多操作"
    {disabled}
  >
    <Icon name="more" size={14} />
  </button>
</div>
