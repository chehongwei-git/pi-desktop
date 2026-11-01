<!-- 附件预览就地展开，不挂载弹窗；按附件位置区分重复内容。 -->
<script lang="ts">
  import { tick } from 'svelte';
  import Icon from './Icon.svelte';
  import type { MessageImage } from '../types';
  let {
    images = $bindable<MessageImage[]>([]),
    historyKey = '',
    onempty,
  }: {
    images?: MessageImage[];
    historyKey?: string;
    onempty: () => void;
  } = $props();
  let selected = $state<number | null>(null);
  let failed = $state<string[]>([]);
  let root: HTMLDivElement;
  const previewId = $props.id();
  let current = $derived(selected === null ? undefined : images[selected]);
  $effect(() => {
    historyKey;
    selected = null;
    failed = [];
  });
  $effect(() => {
    if (!images.length) selected = null;
  });
  function close(): void {
    const index = selected;
    selected = null;
    if (index !== null)
      root
        .querySelector<HTMLButtonElement>(`[data-thumbnail="${index}"]`)
        ?.focus();
  }
  /** 删除前面的图片时平移预览索引，删除当前项则关闭；焦点回到相邻附件。 */
  async function remove(index: number): Promise<void> {
    if (selected === index) selected = null;
    else if (selected !== null && index < selected) selected--;
    images = images.filter((_, position) => position !== index);
    await tick();
    const next = root?.querySelector<HTMLButtonElement>(
      `[data-thumbnail="${Math.min(index, images.length - 1)}"]`,
    );
    if (next) next.focus();
    else onempty();
  }
  function fail(id: string): void {
    if (!failed.includes(id)) failed = [...failed, id];
  }
</script>

<!-- Escape 在容器统一处理子按钮冒泡，容器本身不参与 Tab。 -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  bind:this={root}
  class="attachments"
  role="group"
  aria-label="待发送图片"
  onkeydown={(event) => {
    if (event.key === 'Escape' && selected !== null) {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  }}
>
  {#if current}
    <section
      id={previewId}
      class="attachment-preview"
      aria-label="待发送图片预览"
    >
      <div class="preview-header">
        <span>图片预览 · {selected! + 1} / {images.length}</span>
        <button
          type="button"
          class="preview-close"
          aria-label="收起预览"
          onclick={close}><Icon name="close" size={16} /></button
        >
      </div>
      {#if failed.includes(current.id)}<p role="status">
          此图片无法预览，可移除后重新添加
        </p>
      {:else}<img
          class="large-image"
          src={`data:${current.mimeType};base64,${current.data}`}
          alt={`预览：${current.name ?? '图片'}`}
          onerror={() => fail(current.id)}
        />{/if}
    </section>
  {/if}
  <div class="image-attachments">
    {#each images as image, index (`${image.id}-${index}`)}
      <div class="image-attachment">
        <button
          type="button"
          class="thumbnail"
          class:selected={selected === index}
          data-thumbnail={index}
          aria-label={`放大${image.name ?? '图片'}（${index + 1}）`}
          aria-expanded={selected === index}
          aria-controls={selected === index ? previewId : undefined}
          title={image.name ?? '图片'}
          onclick={() => {
            selected = selected === index ? null : index;
          }}
        >
          {#if failed.includes(image.id)}<span class="image-failed"
              ><Icon name="image" size={23} /><span>无法预览</span></span
            >
          {:else}<img
              src={`data:${image.mimeType};base64,${image.data}`}
              alt={image.name ?? '待发送图片'}
              onerror={() => fail(image.id)}
            />{/if}
        </button>
        <button
          type="button"
          class="remove-image"
          aria-label={`移除${image.name ?? '图片'}`}
          title="移除图片"
          onclick={() => {
            void remove(index);
          }}><Icon name="close" size={13} /></button
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
  .image-attachments {
    display: flex;
    gap: 12px;
    overflow-x: auto;
    overscroll-behavior-x: contain;
    padding: 6px 4px 8px;
    scrollbar-width: thin;
  }
  .image-attachment {
    position: relative;
    flex: 0 0 80px;
    width: 80px;
    height: 80px;
  }
  .thumbnail {
    display: grid;
    place-items: center;
    width: 100%;
    height: 100%;
    padding: 3px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--surface);
    overflow: hidden;
    cursor: zoom-in;
  }
  .thumbnail img {
    width: 100%;
    height: 100%;
    min-height: 0;
    object-fit: contain;
    border-radius: 8px;
  }
  .thumbnail:hover {
    border-color: var(--muted);
  }
  .thumbnail.selected {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent);
    cursor: zoom-out;
  }
  button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .remove-image,
  .preview-close {
    display: grid;
    place-items: center;
    width: 24px;
    height: 24px;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: 50%;
    background: var(--input-surface);
    color: var(--text);
  }
  .remove-image {
    position: absolute;
    right: -4px;
    top: -4px;
    box-shadow: 0 1px 4px #0002;
  }
  .remove-image:hover,
  .preview-close:hover {
    background: var(--surface);
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
  p {
    color: var(--muted);
    padding: 12px;
    font-size: 12px;
  }
</style>
