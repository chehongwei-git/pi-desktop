<script lang="ts">
  import { tick } from 'svelte';

  import type { Desktop } from '../state/desktop.svelte';
  import type { SidebarItem } from '../types';
  let {
    desktop,
    onrename,
  }: {
    desktop: Desktop;
    onrename: (
      kind: SidebarItem['kind'],
      path: string,
      label: string,
      origin: HTMLElement,
    ) => void;
  } = $props();
  let target = $state<{
    kind: SidebarItem['kind'];
    path: string;
    label: string;
  } | null>(null);
  let position = $state<{ x: number; y: number } | null>(null);

  let error = $state('');
  let busy = $state(false);
  let trigger: HTMLElement | null = null;
  let menu = $state<HTMLDivElement>();
  function close(restore = true): void {
    position = null;
    if (restore && trigger?.isConnected) trigger.focus({ preventScroll: true });
  }
  async function context(event: MouseEvent): Promise<void> {
    if (busy) return;
    const source = (event.target as Element).closest<HTMLElement>(
      '[data-sidebar-more]',
    );
    const row = source?.closest('.session-row, .project-row');
    const node = source
      ? row?.querySelector<HTMLElement>('[data-sidebar-kind]')
      : (event.target as Element).closest<HTMLElement>('[data-sidebar-kind]');
    if (!node || desktop.openingSession || desktop.sidebarSaving) return;
    event.preventDefault();
    trigger = source ?? node;
    target = {
      kind: node.dataset.sidebarKind as SidebarItem['kind'],
      path: node.dataset.sidebarPath!,
      label: node.dataset.sidebarLabel!,
    };
    const bounds = trigger.getBoundingClientRect();
    position = {
      x: Math.max(
        4,
        Math.min(source ? bounds.left : event.clientX, window.innerWidth - 190),
      ),
      y: Math.max(
        4,
        Math.min(
          source ? bounds.bottom + 4 : event.clientY,
          window.innerHeight - 150,
        ),
      ),
    };
    await tick();
    menu?.querySelector<HTMLButtonElement>('button')?.focus();
  }
  function choose(): void {
    close(false);
    if (target && trigger)
      onrename(target.kind, target.path, target.label, trigger);
  }
  async function apply(state?: SidebarItem['state']): Promise<void> {
    if (!target || busy) return;
    const item = target;
    const origin = trigger;
    const region = origin?.closest('section');
    const controls = [
      ...(region?.querySelectorAll<HTMLButtonElement>('[data-sidebar-kind]') ??
        []),
    ];
    const subject =
      origin
        ?.closest('.session-row, .project-row')
        ?.querySelector('[data-sidebar-kind]') ?? origin;
    const index = controls.indexOf(subject as HTMLButtonElement);
    busy = true;
    error = '';
    try {
      await desktop.manageSidebar(item.kind, item.path, { state });
      close();
      if (state) {
        await tick();
        if (!origin?.isConnected) {
          const remaining = region?.querySelectorAll<HTMLButtonElement>(
            '[data-sidebar-kind]',
          );
          (
            remaining?.[Math.max(0, Math.min(index, remaining.length - 1))] ??
            region?.querySelector<HTMLButtonElement>('button')
          )?.focus({ preventScroll: true });
        }
      }
    } catch (cause) {
      error = String(cause);
      if (state) desktop.sidebarError = error;
      else desktop.sidebarError = error;
    } finally {
      busy = false;
    }
  }
</script>

<svelte:window
  oncontextmenu={context}
  onclick={(event) => {
    if ((event.target as Element).closest('[data-sidebar-more]'))
      void context(event);
  }}
  onpointerdown={(event) => {
    if (position && !menu?.contains(event.target as Node)) close(false);
  }}
  onblur={() => close(false)}
  onkeydown={(event) => {
    if (!position) return;
    if (event.key === 'Escape' || event.key === 'Tab') {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
      }
      close();
      return;
    }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const buttons = [
        ...(menu?.querySelectorAll<HTMLButtonElement>('button') ?? []),
      ];
      const index = buttons.indexOf(
        document.activeElement as HTMLButtonElement,
      );
      buttons[
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? buttons.length - 1
            : (index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) %
              buttons.length
      ]?.focus();
    }
  }}
/>
{#if position && target}
  <div
    class="sidebar-context"
    role="menu"
    aria-label={target.kind === 'project' ? '项目操作' : '会话操作'}
    bind:this={menu}
    style:left={`${position.x}px`}
    style:top={`${position.y}px`}
  >
    <button role="menuitem" onclick={choose}>重命名</button>
    <button
      role="menuitem"
      onclick={() => {
        close();
        void apply('archived');
      }}>归档</button
    >
  </div>
{/if}

<style>
  .sidebar-context {
    position: fixed;
    z-index: 100;
    width: 180px;
    padding: 5px;
    border: 1px solid var(--border, #8885);
    border-radius: 10px;
    background: var(--surface, #fff);
    color: var(--text, #222);
    box-shadow: 0 8px 30px #0003;
  }
  .sidebar-context button {
    display: block;
    width: 100%;
    text-align: left;
    padding: 9px 12px;
    border: 0;
    background: transparent;
    color: inherit;
    border-radius: 5px;
  }
  .sidebar-context button:hover,
  .sidebar-context button:focus-visible {
    background: #8882;
  }
</style>
