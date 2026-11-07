<!-- Plan 扩展仍是完成状态的唯一来源；此处只解析展示，不提供可误操作的复选框。 -->
<script lang="ts">
  import Icon from './Icon.svelte';
  import { planSteps } from '../plan-steps';
  let {
    lines,
    running = false,
    disabled = false,
    oncontinue,
    onstop,
  }: {
    lines: string[];
    running?: boolean;
    disabled?: boolean;
    oncontinue?: () => Promise<void>;
    onstop?: () => Promise<void>;
  } = $props();
  let busy = $state(false);
  let error = $state('');
  let info = $derived(
    lines
      .filter((line) => line.startsWith('ℹ '))
      .map((line) => line.slice(2))
      .join(' · '),
  );
  /** 按钮只提交一次；错误留在计划旁，用户草稿不参与命令发送。 */
  async function act(action: () => Promise<void>): Promise<void> {
    if (busy) return;
    busy = true;
    error = '';
    try {
      await action();
    } catch (cause) {
      error = String(cause);
    } finally {
      busy = false;
    }
  }
  let expanded = $state(false);
  const listId = $props.id();
  let toggle = $state<HTMLButtonElement>();
  let steps = $derived(planSteps(lines));
  let completed = $derived(steps.filter((step) => step.completed).length);
  let skipped = $derived(steps.filter((step) => step.skipped).length);
  let processed = $derived(completed + skipped);
  let current = $derived(
    steps.findIndex((step) => !step.completed && !step.skipped),
  );
</script>

{#if steps.length}
  <section class="plan-card" aria-label="执行计划">
    <div class="plan-header">
      <span class="plan-icon"
        ><Icon name={current === -1 ? 'check' : 'checklist'} size={17} /></span
      >
      <strong>执行计划</strong>
      <span class="plan-count"
        >{processed} / {steps.length}{skipped ? ' 已处理' : ''}</span
      >
      <button
        bind:this={toggle}
        type="button"
        aria-expanded={expanded}
        aria-controls={listId}
        onclick={() => {
          expanded = !expanded;
        }}
      >
        {expanded ? '收起步骤' : '展开全部'}<span class:expanded
          ><Icon name="down" size={14} /></span
        >
      </button>
    </div>
    <progress value={processed} max={steps.length} aria-label="计划完成进度"
      >{processed} / {steps.length}</progress
    >
    <div class="plan-current" aria-live="polite" aria-atomic="true">
      {#if current === -1}<Icon name="check" size={14} /><span
          >{skipped
            ? `计划已结束 · ${completed} 步完成，${skipped} 步受限`
            : '全部步骤已完成'}</span
        >
      {:else}<span class="current-label"
          >{running ? '正在执行' : '接下来'} · {current + 1}</span
        ><span class="current-text">{steps[current].text}</span>{/if}
    </div>
    {#if info}<p class="plan-info" role="status">{info}</p>{/if}
    {#if current !== -1 && (oncontinue || onstop)}
      <div class="plan-actions">
        {#if !running && oncontinue}<button
            disabled={disabled || busy}
            onclick={() => act(oncontinue!)}
            >{busy ? '正在提交…' : '继续执行'}</button
          >{/if}
        {#if onstop}<button
            disabled={disabled || busy}
            onclick={() => act(onstop!)}>停止计划</button
          >{/if}
      </div>
    {/if}
    {#if error}<p class="plan-info" role="alert">{error}</p>{/if}
    <!-- 可滚动的只读步骤区需要键盘焦点以便方向键滚动；Escape 返回展开入口。 -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
    <div
      id={listId}
      hidden={!expanded}
      class="plan-list"
      onkeydown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          expanded = false;
          toggle?.focus();
        }
      }}
      role="group"
      aria-label="计划步骤"
      tabindex="0"
    >
      <ol>
        {#each steps as step, index}
          <li
            class:completed={step.completed}
            class:current={index === current}
          >
            <span
              class="step-state"
              aria-label={step.completed
                ? '已完成'
                : step.skipped
                  ? '受限未完成'
                  : '未完成'}
            >
              {#if step.completed}<Icon
                  name="check"
                  size={13}
                />{:else if step.skipped}⊘{:else}<span class="step-dot"
                ></span>{/if}
            </span>
            <span class="step-number" aria-hidden="true">{index + 1}.</span>
            <span class="step-text">{step.text}</span>
          </li>
        {/each}
      </ol>
    </div>
  </section>
{/if}

<style>
  .plan-info {
    margin: 6px 0 0;
    color: var(--muted);
    overflow-wrap: anywhere;
  }
  .plan-actions {
    display: flex;
    gap: 8px;
    margin-top: 6px;
  }
  .plan-actions button {
    margin-left: 0;
    border: 1px solid var(--border);
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .plan-card {
    padding: 10px 12px;
    margin-bottom: 10px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--input-surface);
    color: var(--text);
    font-size: 12px;
    min-width: 0;
  }
  .plan-header {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 28px;
  }
  .plan-icon {
    display: flex;
    color: var(--accent);
  }
  strong {
    font-size: 12px;
    font-weight: 600;
    white-space: nowrap;
  }
  .plan-count {
    padding: 2px 7px;
    border-radius: 6px;
    background: var(--surface);
    color: var(--muted);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    margin-left: auto;
    padding: 5px 7px;
    min-height: 28px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--muted);
    font-size: 12px;
    white-space: nowrap;
  }
  button:hover {
    background: var(--surface);
    color: var(--text);
  }
  button:focus-visible,
  .plan-list:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  button span {
    display: flex;
  }
  button span.expanded {
    transform: rotate(180deg);
  }
  progress {
    display: block;
    width: 100%;
    height: 3px;
    margin: 8px 0 10px;
    border: 0;
    border-radius: 3px;
    overflow: hidden;
    appearance: none;
    background: var(--surface);
    accent-color: var(--accent);
  }
  progress::-webkit-progress-bar {
    background: var(--surface);
  }
  progress::-webkit-progress-value {
    background: var(--accent);
    border-radius: 3px;
  }
  progress::-moz-progress-bar {
    background: var(--accent);
    border-radius: 3px;
  }
  .plan-current {
    display: flex;
    align-items: baseline;
    gap: 8px;
    line-height: 1.6;
    min-width: 0;
  }
  .current-label {
    color: var(--accent);
    flex-shrink: 0;
    font-weight: 500;
  }
  .current-text {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    overflow-wrap: anywhere;
  }
  .plan-list {
    max-height: min(200px, 24vh);
    overflow: auto;
    overscroll-behavior: contain;
    scrollbar-gutter: stable;
    margin-top: 10px;
    border-top: 1px solid var(--border);
    border-radius: 2px;
  }
  .plan-list[hidden] {
    display: none;
  }
  ol {
    list-style: none;
    margin: 0;
    padding: 6px 0 0;
  }
  li {
    display: flex;
    align-items: baseline;
    gap: 7px;
    padding: 6px;
    line-height: 1.6;
    border-radius: 6px;
  }
  li.current {
    background: var(--accent-soft);
  }
  .step-state {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    flex-shrink: 0;
    color: var(--muted);
  }
  .step-dot {
    width: 7px;
    height: 7px;
    border: 1px solid currentColor;
    border-radius: 50%;
  }
  .current .step-state,
  .completed .step-state {
    color: var(--accent);
  }
  .step-number {
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .step-text {
    min-width: 0;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }
  .completed .step-text {
    color: var(--muted);
    text-decoration: line-through;
  }
</style>
