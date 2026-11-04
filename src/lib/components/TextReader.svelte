<!-- 展示正文按页读取；关闭/切换组件使迟到结果失效，失败保留已读页并从原偏移重试。 -->
<script lang="ts">
  import { onMount } from 'svelte';
  import type { ContentPage, MessageTextPart } from '../types';
  let {
    source,
    read,
    text = $bindable(''),
    complete = $bindable(false),
  }: {
    source: Pick<MessageTextPart, 'text' | 'contentRef'> & {
      truncated?: boolean;
    };
    read: (id: string, offset: number) => Promise<ContentPage>;
    text?: string;
    complete?: boolean;
  } = $props();
  let loading = $state(false);
  let error = $state('');
  let alive = true;
  let offset = 0;
  let published = 0;
  let chunks: string[] = [];
  export async function load(): Promise<void> {
    if (loading || complete) return;
    if (!source.truncated) {
      text = source.text;
      complete = true;
      return;
    }
    if (!source.contentRef) {
      error = '全文暂不可用，请重新打开会话后重试';
      return;
    }
    loading = true;
    error = '';
    try {
      while (alive && !complete) {
        const page = await read(source.contentRef, offset);
        if (!alive) return;
        if (!page.done && page.next <= offset)
          throw new Error('正文读取未前进，请重试');
        chunks.push(page.text);
        offset = page.next;
        complete = page.done;
        // 按 64KiB 批量发布，避免每个小页都重排十万字的长行；失败仍展示全部已读内容。
        if (complete || offset - published >= 65536) {
          text = chunks.join('');
          published = offset;
        }
        if (!complete)
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    } catch (cause) {
      if (alive) {
        text = chunks.join('');
        error = String(cause);
      }
    } finally {
      if (alive) loading = false;
    }
  }
  onMount(() => {
    void load();
    return () => {
      alive = false;
      chunks = [];
    };
  });
</script>

<div class="user-plain-text">{text || source.text}</div>
{#if loading}<p class="text-read-status" role="status">正在读取全文…</p>{/if}
{#if error}<p class="text-read-error" role="alert">{error}</p>
  <button class="text-button" onclick={() => void load()}>重试读取全文</button
  >{/if}
