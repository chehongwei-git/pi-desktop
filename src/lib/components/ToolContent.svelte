<script lang="ts">
  import { untrack } from 'svelte';
  import type { ContentPage } from '../types';
  import ToolCode from './ToolCode.svelte';
  let {
    id,
    language,
    diff = false,
    read,
  }: {
    id: string;
    language?: string;
    diff?: boolean;
    read: (id: string, offset: number) => Promise<ContentPage>;
  } = $props();
  let text = $state('');
  let next = $state(0);
  let done = $state(false);
  let loading = $state(false);
  let error = $state('');
  let generation = 0;
  async function load(ref: string, serial: number): Promise<void> {
    if (loading || done) return;
    loading = true;
    error = '';
    try {
      const page = await read(ref, next);
      if (serial !== generation) return;
      if (!page.done && page.next <= next)
        throw new Error('正文读取未前进，请重试');
      text += page.text;
      next = page.next;
      done = page.done;
    } catch (cause) {
      if (serial === generation) error = String(cause);
    } finally {
      if (serial === generation) loading = false;
    }
  }
  $effect(() => {
    const ref = id;
    const serial = ++generation;
    text = '';
    next = 0;
    done = false;
    loading = false;
    error = '';
    untrack(() => {
      void load(ref, serial);
    });
    return () => {
      generation++;
    };
  });
</script>

{#if text}<ToolCode {text} {language} {diff} />{/if}
{#if !text && done}<p class="tool-empty">无输出</p>{/if}
{#if loading}<p class="tool-load-status" role="status">正在读取…</p>{/if}
{#if error}<p class="tool-load-error" role="alert">{error}</p>{/if}
{#if !done}<button
    class="text-button tool-load-more"
    disabled={loading}
    onclick={() => {
      void load(id, generation);
    }}>{error ? '重试读取' : '继续加载输出'}</button
  >{/if}
{#if next}<p class="tool-load-status">
    已读取 {Math.ceil(next / 1024)} KiB{done ? ' · 已到末尾' : ''}
  </p>{/if}
