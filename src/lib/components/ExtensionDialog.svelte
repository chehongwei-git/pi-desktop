<!-- Pi 扩展交互适配：请求独立计时/独立 ID，超时后关闭，迟到响应不会污染下一弹窗。 -->
<script lang="ts">
  import { onMount } from 'svelte';
  import Modal from './Modal.svelte';
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
  /** keyed 弹层每个 request 只拍摄一次初值，避免输入被外部通知重置。 */
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

<Modal
  title={request.title ?? 'Pi 需要你的输入'}
  onclose={() => respond({ cancelled: true })}
>
  {#if request.message}<p class="dialog-message">{request.message}</p>{/if}
  {#if request.method === 'select'}<div class="option-list">
      {#each request.options ?? [] as option}<button
          onclick={() => respond({ value: option })}>{option}</button
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
      <button onclick={() => respond({ cancelled: true })}>取消</button><button
        class="primary"
        onclick={() => respond({ value })}>提交</button
      >
    </footer>{/if}
</Modal>
