<!-- 扩展交互统一呈现在对话底部，独立 ID 与计时器保证响应不会污染下一个请求。 -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { terminalText } from '../terminal-text';
  import type { ExtensionRequest } from '../types';
  /** value/confirmed/cancelled 与 Pi extension_ui_response 字段一一对应。 */
  let {
    request,
    onrespond,
  }: {
    request: ExtensionRequest;
    onrespond: (value: {
      value?: string;
      confirmed?: boolean;
      cancelled?: boolean;
    }) => void;
  } = $props();
  let value = $state(initialValue());
  let completed = false;
  /** keyed 交互区每个 request 只拍摄一次初值，避免输入被外部通知重置。 */
  function initialValue(): string {
    return request.prefill ?? request.defaultValue ?? '';
  }
  /** 组件卸载清除 timeout，提交/超时竞态最多消费一次。 */
  function respond(response: {
    value?: string;
    confirmed?: boolean;
    cancelled?: boolean;
  }): void {
    if (completed) return;
    completed = true;
    onrespond(response);
  }
  onMount(() => {
    if (request.timeout === undefined) return;
    const timer = setTimeout(
      () => respond({ cancelled: true }),
      request.timeout,
    );
    return () => clearTimeout(timer);
  });
</script>

{#snippet content()}
  {#if request.message}<p class="dialog-message">{request.message}</p>{/if}
  {#if request.method === 'select'}<div class="option-list">
      {#each request.options ?? [] as option}<button
          onclick={() => respond({ value: option })}
          >{terminalText(option)}</button
        >{/each}
    </div>
  {:else if request.method === 'confirm'}<footer class="modal-actions">
      <button onclick={() => respond({ confirmed: false })}>拒绝</button><button
        class="primary"
        onclick={() => respond({ confirmed: true })}>确认</button
      >
    </footer>
  {:else}<label class="dialog-field"
      ><span class="sr-only">输入内容</span
      >{#if request.method === 'editor'}<textarea bind:value rows="8"
        ></textarea>{:else}<input
          bind:value
          onkeydown={(event) => {
            if (event.key === 'Enter' && !event.isComposing) respond({ value });
          }}
        />{/if}</label
    >
    <footer class="modal-actions">
      <button class="primary" onclick={() => respond({ value })}>提交</button>
    </footer>{/if}
{/snippet}

<section class="inline-choice" aria-label={request.title ?? 'Pi 需要你的输入'}>
  <header>
    <strong>{request.title ?? 'Pi 需要你的输入'}</strong>
    <button class="text-button" onclick={() => respond({ cancelled: true })}
      >取消</button
    >
  </header>
  {@render content()}
</section>

<style>
  .inline-choice {
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 12px;
    margin-bottom: 10px;
    max-height: 30vh;
    overflow-y: auto;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 8px;
  }
  strong {
    font-size: 13px;
  }
</style>
