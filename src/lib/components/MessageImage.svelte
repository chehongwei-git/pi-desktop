<!-- 图片仅从宿主受控引用读取；卸载后不再提交迟到结果。 -->
<script lang="ts">
  import { onMount } from 'svelte';
  import type { ContentPage, MessageImage } from '../types';
  let {
    image,
    read,
  }: {
    image: MessageImage;
    read: (id: string, offset: number) => Promise<ContentPage>;
  } = $props();
  let data = $state('');
  let error = $state('');
  let busy = $state(false);
  let expanded = $state(false);
  let alive = true;
  async function load(): Promise<void> {
    if (busy || data || !image.contentRef) return;
    busy = true;
    error = '';
    try {
      const parts: string[] = [];
      let offset = 0;
      while (alive) {
        const page = await read(image.contentRef, offset);
        if (!alive) return;
        parts.push(page.text);
        if (page.done) {
          data = parts.join('');
          break;
        }
        if (page.next <= offset || page.next > 32 * 1024 * 1024)
          throw new Error('图片数据无效');
        offset = page.next;
      }
    } catch {
      if (alive) error = '图片读取失败';
    } finally {
      if (alive) busy = false;
    }
  }
  onMount(() => {
    data = image.data ?? '';
    void load();
    return () => {
      alive = false;
    };
  });
</script>

<div class="message-image" class:expanded>
  {#if data}<button
      type="button"
      aria-label={expanded ? '收起图片' : '展开图片'}
      aria-expanded={expanded}
      onclick={() => {
        expanded = !expanded;
      }}
    >
      <img
        loading="lazy"
        src={`data:${image.mimeType};base64,${data}`}
        alt={image.name ?? '用户发送的图片'}
      />
    </button>
  {:else if error}<span role="alert">{error}</span><button
      type="button"
      onclick={() => {
        void load();
      }}>重试</button
    >
  {:else}<span role="status">正在读取图片…</span>{/if}
</div>

<style>
  .message-image {
    min-height: 100px;
    margin-block: 8px;
  }
  button {
    background: transparent;
    border: 0;
    padding: 4px;
    cursor: pointer;
  }
  img {
    display: block;
    max-width: min(280px, 100%);
    max-height: 180px;
    object-fit: contain;
    border-radius: 8px;
  }
  .expanded img {
    max-width: 100%;
    max-height: 70vh;
  }
</style>
