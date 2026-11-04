<!-- 与代码变更共用侧栏空间，原文只读，不把查看误作编辑或重新发送。 -->
<script lang="ts">
  import { onMount } from 'svelte';
  import type { ContentPage, MessageTextPart } from '../types';
  import TextReader from './TextReader.svelte';
  let {
    part,
    read,
    onclose,
    position = $bindable(0),
  }: {
    part: MessageTextPart;
    read: (id: string, offset: number) => Promise<ContentPage>;
    onclose: () => void;
    position?: number;
  } = $props();
  let close: HTMLButtonElement;
  let body: HTMLDivElement;
  let text = $state('');
  let complete = $state(false);
  let error = $state('');
  let copied = $state(false);
  let timer: ReturnType<typeof setTimeout>;
  onMount(() => {
    close.focus({ preventScroll: true });
    body.scrollTop = position;
    return () => clearTimeout(timer);
  });
  async function copy(): Promise<void> {
    if (!complete) return;
    error = '';
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
      clearTimeout(timer);
      timer = setTimeout(() => {
        copied = false;
      }, 1500);
    } catch {
      error = '无法复制原文，请检查剪贴板权限后重试';
    }
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions (面板内 Escape 关闭并由列表恢复触发入口焦点。) -->
<aside
  class="change-panel text-detail-panel"
  aria-label="粘贴文本全文"
  onkeydown={(event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onclose();
    }
  }}
>
  <header class="change-panel-header text-panel-header">
    <div class="text-panel-title">
      <strong>粘贴文本</strong><span>{part.chars.toLocaleString()} 字</span>
    </div>
    <button class="text-button" disabled={!complete} onclick={() => void copy()}
      >{copied ? '已复制' : complete ? '复制原文' : '读取中…'}</button
    >
    <button class="text-button" bind:this={close} onclick={onclose}
      >关闭全文</button
    >
  </header>
  {#if error}<p class="text-read-error" role="alert">{error}</p>{/if}
  <div
    class="change-panel-body text-panel-body"
    bind:this={body}
    onscroll={() => {
      position = body.scrollTop;
    }}
  >
    <TextReader source={part} {read} bind:text bind:complete />
  </div>
</aside>
