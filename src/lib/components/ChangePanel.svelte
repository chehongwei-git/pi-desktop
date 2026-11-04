<!-- 面板按正文引用重建；异步读取在卸载时失效，旧结果不会覆盖新文件。 -->
<script lang="ts">
  import { onMount, tick } from 'svelte';
  import type { ContentPage, Message } from '../types';
  import ToolCode from './ToolCode.svelte';
  import { languageForPath } from '../tool-presentation';
  let {
    message,
    read,
    onclose,
  }: {
    message: Message;
    read: (id: string, offset: number) => Promise<ContentPage>;
    onclose: () => void;
  } = $props();
  let text = $state('');
  let next = 0;
  let done = $state(false);
  let loading = $state(false);
  let error = $state('');
  let alive = true;
  let close: HTMLButtonElement;
  let ref = $derived(message.tool?.diffRef ?? message.tool?.writeRef);
  /** 完整差异逐块串行读取；每块让出主线程，失败保留正文与读取偏移。 */
  async function load(): Promise<void> {
    if (loading || done || !ref) return;
    loading = true;
    error = '';
    try {
      while (alive && !done) {
        const page = await read(ref, next);
        if (!alive) return;
        if (!page.done && page.next <= next)
          throw new Error('正文读取未前进，请重试');
        text += page.text;
        next = page.next;
        done = page.done;
        await tick();
        if (!done) await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    } catch (cause) {
      if (alive) error = String(cause);
    } finally {
      if (alive) loading = false;
    }
  }
  onMount(() => {
    close.focus({ preventScroll: true });
    void load();
    return () => {
      alive = false;
    };
  });
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions (Escape 统一关闭内嵌面板，不拦截其他键盘操作。) -->
<aside
  class="change-panel"
  aria-label="代码变更"
  onkeydown={(event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onclose();
    }
  }}
>
  <header class="change-panel-header">
    <strong>{message.tool?.path ?? '代码变更'}</strong>
    <button class="text-button" bind:this={close} onclick={onclose}
      >关闭变更</button
    >
  </header>
  {#if !message.tool?.diffRef}<p class="tool-load-status">新增内容</p>{/if}
  <div class="change-panel-body">
    {#if text}<ToolCode
        {text}
        diff={!!message.tool?.diffRef}
        language={message.tool?.diffRef
          ? undefined
          : languageForPath(message.tool?.path ?? '')}
      />{/if}
    {#if loading}<p role="status" class="tool-load-status">
        正在读取完整变更…
      </p>{/if}
    {#if error}<p role="alert" class="tool-load-error">{error}</p>
      <button class="text-button" onclick={() => void load()}
        >重试读取变更</button
      >{/if}
    {#if done}<p class="tool-load-status">
        {text ? '已显示完整内容' : '无变更内容'}
      </p>{/if}
  </div>
</aside>
