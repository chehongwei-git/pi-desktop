<!-- 就地编辑显示别名；失败保留输入，结束后由调用方恢复焦点。 -->
<script lang="ts">
  import { onMount } from 'svelte';
  import type { Desktop } from '../state/desktop.svelte';
  import type { SidebarItem } from '../types';
  let {
    desktop,
    kind,
    path,
    label,
    onclose,
  }: {
    desktop: Desktop;
    kind: SidebarItem['kind'];
    path: string;
    label: string;
    onclose: () => void;
  } = $props();
  let value = $state('');
  let error = $state('');
  let busy = $state(false);
  let input: HTMLInputElement;
  onMount(() => {
    value = label;
    input.focus();
    input.select();
  });
  async function save(): Promise<void> {
    if (busy || desktop.sidebarSaving || !value.trim()) return;
    busy = true;
    error = '';
    try {
      await desktop.manageSidebar(kind, path, { name: value.trim() });
      onclose();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      busy = false;
    }
  }
</script>

<form
  class="sidebar-rename"
  onsubmit={(event) => {
    event.preventDefault();
    void save();
  }}
>
  <input
    bind:this={input}
    bind:value
    maxlength="200"
    aria-label={`重命名${kind === 'project' ? '项目' : '会话'}`}
    disabled={busy}
    onkeydown={(event) => {
      event.stopPropagation();
      if (event.key === 'Escape' && !busy) {
        event.preventDefault();
        onclose();
      }
      if (event.key === 'Enter' && event.isComposing) event.preventDefault();
    }}
  />
  <div class="rename-actions">
    <button
      type="submit"
      disabled={busy || desktop.sidebarSaving || !value.trim()}
      >{busy ? '保存中…' : '保存'}</button
    >
    <button type="button" disabled={busy} onclick={onclose}>取消</button>
  </div>
  {#if error}<p role="alert">{error}</p>{/if}
</form>
