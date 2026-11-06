<!-- 已发送引用仅展示路径，不读取磁盘；展开状态由会话保存以适应虚拟列表。 -->
<script lang="ts">
  import { tick } from 'svelte';
  import { pathName, pathParent } from '../attachments';
  import type { MessageFileReference } from '../types';
  import Icon from './Icon.svelte';
  let {
    files,
    views,
    toggle,
    onlayout,
  }: {
    files: MessageFileReference[];
    views: Record<string, boolean>;
    toggle: (key: string) => void;
    onlayout: (change: () => void, trigger?: HTMLElement) => void;
  } = $props();
  let root = $state<HTMLElement>();
  let feedback = $state('');
  let timer: ReturnType<typeof setTimeout>;
  let expanded = $derived(!!views['files:more']);
  let selected = $derived(files.find((file) => views[`file:${file.id}`]));
  let visible = $derived(expanded ? files : files.slice(0, 4));
  function nameParts(path: string): [string, string] {
    const name = pathName(path);
    const dot = name.lastIndexOf('.');
    return dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  }
  function change(key: string, trigger?: HTMLElement) {
    onlayout(() => toggle(key), trigger);
  }
  function select(file: MessageFileReference, trigger: HTMLButtonElement) {
    onlayout(() => {
      if (selected && selected.id !== file.id) toggle(`file:${selected.id}`);
      toggle(`file:${file.id}`);
    }, trigger);
  }
  function close() {
    const id = selected?.id;
    if (!id) return;
    change(`file:${id}`);
    void tick().then(() =>
      root
        ?.querySelector<HTMLButtonElement>(
          `[data-file-index="${files.findIndex((file) => file.id === id)}"]`,
        )
        ?.focus({ preventScroll: true }),
    );
  }
  async function copy(path: string) {
    try {
      await navigator.clipboard.writeText(path);
      feedback = '路径已复制';
    } catch {
      feedback = '复制失败，请检查剪贴板权限';
    }
    clearTimeout(timer);
    timer = setTimeout(() => {
      feedback = '';
    }, 2000);
  }
  $effect(() => () => clearTimeout(timer));
</script>

<svelte:window
  onkeydown={(event) => {
    if (
      event.key === 'Escape' &&
      selected &&
      root?.contains(document.activeElement)
    ) {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  }}
/>
<section class="message-files" aria-label="文件引用" bind:this={root}>
  <div class="file-list">
    {#each visible as file, index (file.id)}
      {@const [stem, extension] = nameParts(file.path)}
      <button
        type="button"
        class="file-card"
        class:selected={selected?.id === file.id}
        data-file-index={index}
        aria-label={`查看文件引用：${pathName(file.path)}`}
        aria-expanded={selected?.id === file.id}
        onclick={(event) => select(file, event.currentTarget)}
      >
        <Icon name={file.directory ? 'folder' : 'file'} size={18} />
        <span class="file-info"
          ><span class="file-name"
            ><span>{stem}</span><span>{extension}</span></span
          ><span class="file-parent">{pathParent(file.path)}</span><span
            class="file-kind">{file.directory ? '目录引用' : '路径引用'}</span
          ></span
        >
      </button>
    {/each}
  </div>
  {#if files.length > 4}<button
      type="button"
      class="text-button more"
      aria-expanded={expanded}
      onclick={(event) => {
        if (expanded && selected && files.indexOf(selected) >= 4)
          change(`file:${selected.id}`);
        change('files:more', event.currentTarget);
      }}>{expanded ? '收起' : `展开其余 ${files.length - 4} 项`}</button
    >{/if}
  {#if selected}<div
      class="file-detail"
      role="region"
      aria-label="文件引用详情"
    >
      <div class="detail-heading">
        <span>完整路径</span><button
          type="button"
          class="icon-button"
          aria-label="收起文件详情"
          onclick={close}><Icon name="close" size={15} /></button
        >
      </div>
      <code>{selected.path}</code>
      <div class="detail-actions">
        <span role="status">{feedback}</span><button
          type="button"
          class="text-button"
          onclick={() => void copy(selected!.path)}>复制路径</button
        >
      </div>
    </div>{/if}
</section>

<style>
  .message-files {
    min-width: 0;
    margin-top: 10px;
  }
  .file-list {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .file-card {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 200px;
    max-width: 100%;
    height: 72px;
    padding: 9px 10px;
    text-align: left;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--surface);
    color: var(--muted);
    cursor: pointer;
  }
  .file-card:hover {
    background: var(--bg);
  }
  .file-card.selected {
    border-color: var(--accent);
  }
  .file-card:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .file-info {
    min-width: 0;
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 2px;
  }
  .file-parent {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .file-name {
    display: flex;
    min-width: 0;
    color: var(--text);
    font-size: 13px;
    font-weight: 600;
  }
  .file-name span:first-child {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .file-name span:last-child {
    flex-shrink: 0;
  }
  .file-parent,
  .file-kind {
    font-size: 11px;
  }
  .more {
    margin-top: 6px;
  }
  .file-detail {
    margin-top: 8px;
    padding: 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
  }
  .detail-heading,
  .detail-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    color: var(--muted);
    font-size: 12px;
  }
  .file-detail code {
    display: block;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    color: var(--text);
    font: 12px/1.6 var(--font-mono);
  }
  .detail-actions {
    min-height: 30px;
  }
</style>
