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
  let expanded = $state(true);
  let toggle: HTMLButtonElement;
  /** 收起隐藏区域前将焦点交回入口，避免键盘焦点遗失。 */
  function collapse(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    expanded = false;
    toggle.focus({ preventScroll: true });
  }
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
  {#if request.message}
    {#if request.method === 'select'}<details class="choice-description">
        <summary>查看说明</summary>
        <p class="dialog-message">{request.message}</p>
      </details>
    {:else}<p class="dialog-message">{request.message}</p>{/if}
  {/if}
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

<section
  class="inline-choice"
  class:selection={request.method === 'select'}
  aria-label={request.title ?? 'Pi 需要你的输入'}
>
  <header>
    <strong>{request.title ?? 'Pi 需要你的输入'}</strong>
    <div class="choice-actions">
      <button
        bind:this={toggle}
        class="text-button"
        aria-expanded={expanded}
        onclick={() => {
          expanded = !expanded;
        }}>{expanded ? '收起操作' : '展开操作（待选择）'}</button
      >
      <button class="text-button" onclick={() => respond({ cancelled: true })}
        >取消</button
      >
    </div>
  </header>
  <!-- svelte-ignore a11y_no_static_element_interactions (仅处理子控件冒泡的 Escape，不新增焦点节点。) -->
  <div class="choice-content" hidden={!expanded} onkeydown={collapse}>
    {@render content()}
  </div>
</section>

<style>
  .inline-choice {
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 8px 10px;
    margin-bottom: 8px;
  }
  /* 标题与取消入口常驻；长选项只占有限高度，给方案正文保留空间。 */
  .choice-content {
    max-height: 22dvh;
    overflow-y: auto;
    overscroll-behavior: contain;
  }
  .choice-content[hidden] {
    display: none;
  }
  .selection .option-list {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .selection .option-list button {
    min-height: 32px;
    max-width: 100%;
    overflow-wrap: anywhere;
  }
  .choice-actions {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    gap: 8px;
  }
  .choice-actions button {
    min-height: 28px;
    font-size: 12px;
  }
  .choice-description {
    margin-bottom: 6px;
    font-size: 13px;
  }
  .choice-description summary {
    cursor: pointer;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 6px 12px;
    margin-bottom: 8px;
  }
  strong {
    min-width: 0;
    overflow-wrap: anywhere;
    font-size: 13px;
  }
</style>
