<script lang="ts">
  import { tick } from 'svelte';
  import Modal from './Modal.svelte';
  import type { Desktop } from '../state/desktop.svelte';
  import type { SidebarItem } from '../types';
  let { desktop }: { desktop: Desktop } = $props();
  let target = $state<{
    kind: SidebarItem['kind'];
    path: string;
    label: string;
  } | null>(null);
  let position = $state<{ x: number; y: number } | null>(null);
  let operation = $state<'rename' | null>(null);
  let value = $state('');
  let error = $state('');
  let busy = $state(false);
  let trigger: HTMLElement | null = null;
  let menu = $state<HTMLDivElement>();
  function close(): void {
    position = null;
    trigger?.focus({ preventScroll: true });
  }
  async function context(event: MouseEvent): Promise<void> {
    const node = (event.target as Element).closest<HTMLElement>(
      '[data-sidebar-kind]',
    );
    if (!node || desktop.openingSession || desktop.sidebarSaving) return;
    event.preventDefault();
    trigger = node;
    target = {
      kind: node.dataset.sidebarKind as SidebarItem['kind'],
      path: node.dataset.sidebarPath!,
      label: node.dataset.sidebarLabel!,
    };
    position = {
      x: Math.max(4, Math.min(event.clientX, window.innerWidth - 190)),
      y: Math.max(4, Math.min(event.clientY, window.innerHeight - 150)),
    };
    await tick();
    menu?.querySelector<HTMLButtonElement>('button')?.focus();
  }
  function choose(next: 'rename'): void {
    close();
    operation = next;
    value = target?.label ?? '';
    error = '';
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
    const index = controls.indexOf(origin as HTMLButtonElement);
    busy = true;
    error = '';
    try {
      await desktop.manageSidebar(
        item.kind,
        item.path,
        operation === 'rename' ? { name: value } : { state },
      );
      operation = null;
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
      else desktop.error = error;
    } finally {
      busy = false;
    }
  }
</script>

<svelte:window
  oncontextmenu={context}
  onpointerdown={(event) => {
    if (position && !menu?.contains(event.target as Node)) close();
  }}
  onblur={close}
  onkeydown={(event) => {
    if (!position) return;
    if (event.key === 'Escape' || event.key === 'Tab') {
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
    <button role="menuitem" onclick={() => choose('rename')}>重命名</button>
    <button
      role="menuitem"
      onclick={() => {
        close();
        operation = null;
        void apply('archived');
      }}>归档</button
    >
  </div>
{/if}
{#if operation && target}
  <Modal
    title={`重命名${target.kind === 'project' ? '项目' : '会话'}`}
    onclose={() => {
      if (!busy) operation = null;
    }}
  >
    <form
      onsubmit={(event) => {
        event.preventDefault();
        void apply();
      }}
    >
      <label class="dialog-field"
        >名称<input bind:value maxlength="200" disabled={busy} /></label
      >
      <p class="muted">修改桌面显示名称，原文件和工作目录保持不变。</p>
      {#if error}<p role="alert">{error}</p>{/if}
      <footer class="modal-actions">
        <button
          type="button"
          disabled={busy}
          onclick={() => {
            operation = null;
          }}>取消</button
        ><button
          class="primary"
          disabled={busy || (operation === 'rename' && !value.trim())}
          >保存</button
        >
      </footer>
    </form>
  </Modal>
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
