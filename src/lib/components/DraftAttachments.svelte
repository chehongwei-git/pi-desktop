<!-- 统一附件区：图片与路径按添加顺序排列，详情在当前输入区展开。 -->
<script lang="ts">
  import { tick } from 'svelte';
  import Icon from './Icon.svelte';
  import {
    absolutePath,
    pathName,
    pathParent,
    type DraftAttachment,
  } from '../attachments';
  let {
    attachments = $bindable<DraftAttachment[]>([]),
    historyKey = '',
    onempty,
  }: {
    attachments?: DraftAttachment[];
    historyKey?: string;
    onempty: () => void;
  } = $props();
  let selected = $state<string | null>(null);
  let failed = $state<string[]>([]);
  let editing = $state(false);
  let editedPath = $state('');
  let error = $state('');
  let copied = $state(false);
  let root: HTMLDivElement;
  let pathInput = $state<HTMLTextAreaElement>();
  const previewId = $props.id();
  let current = $derived(attachments.find((item) => item.id === selected));
  const label = (item: DraftAttachment) =>
    item.kind === 'image' ? (item.image.name ?? '图片') : item.name;
  $effect(() => {
    historyKey;
    selected = null;
    editing = false;
    failed = [];
    error = '';
    copied = false;
  });
  $effect(() => {
    if (!current) {
      selected = null;
      editing = false;
    }
  });
  function focusCard(id: string): void {
    Array.from(root.querySelectorAll<HTMLButtonElement>('[data-attachment]'))
      .find((node) => node.dataset.attachment === id)
      ?.focus();
  }
  function close(): void {
    const id = selected;
    selected = null;
    editing = false;
    if (id) focusCard(id);
  }
  function open(id: string): void {
    if (selected === id) {
      close();
      return;
    }
    selected = id;
    editing = false;
    error = '';
    copied = false;
  }
  /** 删除按实例身份处理；相同内容的另一个附件必须保留。 */
  async function remove(id: string): Promise<void> {
    const index = attachments.findIndex((item) => item.id === id);
    attachments = attachments.filter((item) => item.id !== id);
    if (selected === id) close();
    await tick();
    const next = attachments[Math.min(index, attachments.length - 1)];
    if (next) focusCard(next.id);
    else onempty();
  }
  async function editPath(): Promise<void> {
    if (current?.kind !== 'path') return;
    editedPath = current.path;
    editing = true;
    error = '';
    await tick();
    pathInput?.focus();
    pathInput?.select();
  }
  function savePath(): void {
    if (current?.kind !== 'path') return;
    const windows = /Win/i.test(navigator.platform || navigator.userAgent);
    if (!absolutePath(editedPath, windows)) {
      error = '请输入当前系统的完整绝对路径。';
      return;
    }
    const old = current;
    // 编辑后的引用是新实例，旧发送回执不能清除发送期间修改的路径。
    const id = crypto.randomUUID();
    attachments = attachments.map((item) =>
      item.id === old.id
        ? {
            ...old,
            id,
            path: editedPath,
            name: pathName(editedPath),
            directory: false,
            notice: undefined,
          }
        : item,
    );
    selected = id;
    editing = false;
    error = '';
    copied = false;
    void tick().then(() => focusCard(id));
  }
  async function copyPath(): Promise<void> {
    if (current?.kind !== 'path') return;
    const id = current.id;
    try {
      await navigator.clipboard.writeText(current.path);
      if (selected === id) {
        copied = true;
        error = '';
      }
    } catch {
      if (selected === id) error = '复制失败，请展开编辑后手动复制路径。';
    }
  }
  function fail(id: string): void {
    if (!failed.includes(id)) failed = [...failed, id];
  }
  /** 名称中间省略，扩展名独立保留；完整名称同时供键盘和辅助技术读取。 */
  function nameParts(name: string): [string, string] {
    const dot = name.lastIndexOf('.');
    return dot > 0 && name.length - dot <= 16
      ? [name.slice(0, dot), name.slice(dot)]
      : [name, ''];
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  bind:this={root}
  class="attachments"
  role="group"
  aria-label="待发送附件"
  onkeydown={(event) => {
    if (event.key === 'Escape' && selected !== null) {
      event.preventDefault();
      event.stopPropagation();
      if (editing) {
        editing = false;
        error = '';
        focusCard(selected);
      } else close();
    }
  }}
>
  {#if current}
    <section
      id={previewId}
      class="attachment-preview"
      aria-label={current.kind === 'image' ? '待发送图片预览' : '文件引用详情'}
    >
      <div class="preview-header">
        <span
          >{current.kind === 'image' ? '图片预览' : '文件引用'} · {label(
            current,
          )}</span
        >
        <button
          type="button"
          class="preview-close"
          aria-label="收起预览"
          onclick={close}><Icon name="close" size={16} /></button
        >
      </div>
      {#if current.kind === 'image'}
        {#if failed.includes(current.id)}<p role="status">
            此图片无法预览，可移除后重新添加
          </p>
        {:else}<img
            class="large-image"
            src={`data:${current.image.mimeType};base64,${current.image.data}`}
            alt={`预览：${label(current)}`}
            onerror={() => current && fail(current.id)}
          />{/if}
      {:else}
        <div class="path-details">
          {#if editing}
            <label for={`${previewId}-path`}>完整路径</label>
            <textarea
              id={`${previewId}-path`}
              bind:this={pathInput}
              bind:value={editedPath}
              rows="2"
              spellcheck="false"
              aria-invalid={!!error}
              onkeydown={(event) => {
                if (
                  event.key === 'Enter' &&
                  !event.shiftKey &&
                  !event.isComposing &&
                  event.keyCode !== 229
                ) {
                  event.preventDefault();
                  savePath();
                }
              }}></textarea>
            <div class="path-actions">
              <button type="button" onclick={savePath}>保存路径</button><button
                type="button"
                onclick={() => {
                  editing = false;
                  error = '';
                  if (selected) focusCard(selected);
                }}>取消</button
              >
            </div>
          {:else}
            <code>{current.path}</code>
            <div class="path-actions">
              <span>发送时仅引用路径</span><button
                type="button"
                onclick={() => void copyPath()}
                >{copied ? '已复制' : '复制路径'}</button
              ><button type="button" onclick={() => void editPath()}
                >编辑路径</button
              >
            </div>
          {/if}
          {#if error}<p class="attachment-error" role="alert">{error}</p>{/if}
          {#if copied}<span class="sr-only" role="status">路径已复制</span>{/if}
        </div>
      {/if}
    </section>
  {/if}
  <div class="attachment-strip">
    {#each attachments as item, index (item.id)}
      <div class="attachment-item" class:path-item={item.kind === 'path'}>
        <button
          type="button"
          class="attachment-card"
          class:thumbnail={item.kind === 'image'}
          class:selected={selected === item.id}
          data-attachment={item.id}
          aria-label={item.kind === 'image'
            ? `放大${label(item)}（${index + 1}）`
            : `查看文件引用：${item.name}（${index + 1}）`}
          aria-expanded={selected === item.id}
          aria-controls={selected === item.id ? previewId : undefined}
          title={item.kind === 'path' ? item.path : label(item)}
          onclick={() => open(item.id)}
        >
          {#if item.kind === 'image'}
            {#if failed.includes(item.id)}<span class="image-failed"
                ><Icon name="image" size={23} /><span>无法预览</span></span
              >
            {:else}<img
                src={`data:${item.image.mimeType};base64,${item.image.data}`}
                alt={label(item)}
                onerror={() => fail(item.id)}
              />{/if}
          {:else}
            {@const [stem, extension] = nameParts(item.name)}
            <span class="file-icon"
              ><Icon
                name={item.directory ? 'folder' : 'file'}
                size={23}
              /></span
            >
            <span class="file-body"
              ><span class="file-name"
                ><span>{stem}</span><span>{extension}</span></span
              ><span class="file-directory">{pathParent(item.path)}</span><span
                class="file-kind"
                >{item.notice ??
                  (item.directory ? '目录引用' : '路径引用')}</span
              ></span
            >
          {/if}
        </button>
        <button
          type="button"
          class="remove-attachment"
          aria-label={`移除${label(item)}`}
          title="移除附件"
          onclick={() => void remove(item.id)}
          ><Icon name="close" size={13} /></button
        >
      </div>
    {/each}
  </div>
</div>

<style>
  .attachments {
    min-width: 0;
    margin-bottom: 14px;
  }
  .attachment-strip {
    display: flex;
    gap: 12px;
    overflow-x: auto;
    overscroll-behavior-x: contain;
    padding: 6px 4px 8px;
    scrollbar-width: thin;
  }
  .attachment-item {
    position: relative;
    flex: 0 0 80px;
    width: 80px;
    height: 80px;
  }
  .path-item {
    flex-basis: 200px;
    width: 200px;
    max-width: calc(100% - 8px);
  }
  .attachment-card {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    height: 100%;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--surface);
    overflow: hidden;
    text-align: left;
  }
  .thumbnail {
    display: grid;
    place-items: center;
    padding: 3px;
    cursor: zoom-in;
  }
  .thumbnail img {
    width: 100%;
    height: 100%;
    min-height: 0;
    object-fit: contain;
    border-radius: 8px;
  }
  .attachment-card:hover {
    border-color: var(--muted);
  }
  .attachment-card.selected {
    border-color: var(--accent);
    box-shadow: inset 0 0 0 1px var(--accent);
  }
  .thumbnail.selected {
    cursor: zoom-out;
  }
  button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .file-icon {
    flex-shrink: 0;
    color: var(--muted);
    display: flex;
  }
  .file-body {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    flex: 1;
  }
  .file-name {
    display: flex;
    color: var(--text);
    font-size: 14px;
    line-height: 1.4;
    min-width: 0;
  }
  .file-name > :first-child {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .file-name > :last-child {
    flex-shrink: 0;
  }
  .file-directory,
  .file-kind {
    color: var(--muted);
    font-size: 12px;
    line-height: 1.4;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .remove-attachment,
  .preview-close {
    display: grid;
    place-items: center;
    width: 24px;
    height: 24px;
    flex-shrink: 0;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: 50%;
    background: var(--input-surface);
    color: var(--text);
  }
  .remove-attachment {
    position: absolute;
    right: -4px;
    top: -4px;
  }
  .remove-attachment:hover,
  .preview-close:hover {
    background: var(--hover);
    border-color: var(--muted);
  }
  .attachment-preview {
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--surface);
    margin-bottom: 8px;
    overflow: hidden;
  }
  .preview-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 7px 10px;
    color: var(--muted);
    font-size: 12px;
  }
  .preview-header > span {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .large-image {
    display: block;
    width: 100%;
    height: min(260px, 32vh);
    object-fit: contain;
    padding: 0 10px 10px;
    box-sizing: border-box;
  }
  .image-failed {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 5px;
    color: var(--muted);
    font-size: 10px;
  }
  .path-details {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 0 12px 12px;
    max-height: min(260px, 32vh);
    overflow-y: auto;
  }
  .path-details code {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font: 12px/1.6 var(--font-mono);
  }
  .path-details label {
    font-size: 12px;
    color: var(--muted);
  }
  .path-details textarea {
    width: 100%;
    min-height: 60px;
    max-height: 120px;
    resize: vertical;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg);
    font: 12px/1.6 var(--font-mono);
  }
  .path-details textarea:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  .path-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
  .path-actions span {
    flex: 1;
    font-size: 12px;
    color: var(--muted);
  }
  .path-actions button {
    padding: 4px 8px;
    font-size: 12px;
  }
  p {
    color: var(--muted);
    padding: 12px;
    font-size: 12px;
    margin: 0;
  }
  p.attachment-error {
    color: var(--error);
    padding: 0;
  }
  @media (prefers-reduced-motion: reduce) {
    button {
      transition: none;
    }
  }
</style>
