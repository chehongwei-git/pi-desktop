<!-- 模型按服务商分组，思考强度就地展开；提交期间互斥，错误就地展示。 -->
<script lang="ts">
  import { tick } from 'svelte';
  import ModelPicker from './ModelPicker.svelte';
  import type { Desktop } from '../state/desktop.svelte';
  import { errorMessage } from '../client';
  import Icon from './Icon.svelte';
  import { thinkingLevels } from '../model-config';

  let {
    desktop,
    disabled = false,
    busy = $bindable(false),
  }: { desktop: Desktop; disabled?: boolean; busy?: boolean } = $props();
  let error = $state('');
  let thinkingOpen = $state(false);
  let thinkingRoot: HTMLDivElement;
  let thinkingTrigger: HTMLButtonElement;
  const thinkingOptions: Record<
    string,
    { name: string; hint: string; strength: number }
  > = {
    off: { name: '关闭', hint: '不启用额外思考', strength: 0 },
    minimal: { name: '极低', hint: '轻量思考，适合简单任务', strength: 1 },
    low: { name: '低', hint: '适合日常问答与小幅修改', strength: 2 },
    medium: { name: '中等', hint: '兼顾思考深度与响应速度', strength: 3 },
    high: { name: '高', hint: '适合复杂分析与代码推理', strength: 4 },
    xhigh: { name: '极高', hint: '更深入地分析复杂问题', strength: 5 },
    max: { name: '最高', hint: '使用模型支持的最高思考强度', strength: 6 },
  };
  const currentLevel = $derived(desktop.selectedThinking);
  function levelInfo(level: string) {
    return (
      thinkingOptions[level] ?? {
        name: level,
        hint: '模型支持的思考等级',
        strength: 3,
      }
    );
  }
  // 下拉不提供极低等级，已有会话的 minimal 值仍按实际状态展示。
  const levels = $derived(
    (desktop.newChatProject !== null || desktop.hasPendingModel
      ? thinkingLevels.filter(
          (level) =>
            level === 'off' ||
            desktop.selectedModel?.thinkingLevelMap?.[level] !== null,
        )
      : desktop.levels.length
        ? desktop.levels
        : ['off']
    ).filter((level) => level !== 'minimal'),
  );
  const unavailable = $derived(
    disabled ||
      busy ||
      desktop.submitting ||
      !!desktop.openingSession ||
      (desktop.connection !== 'ready' && desktop.newChatProject === null) ||
      desktop.task?.state === 'queued' ||
      desktop.run === 'aborting',
  );

  // 菜单使用原生按钮承接焦点，Tab 移出或点击外部时关闭且不抢焦点。
  async function openThinking(last = false) {
    if (unavailable || levels.length < 2) return;
    thinkingOpen = true;
    await tick();
    const items = thinkingRoot.querySelectorAll<HTMLButtonElement>(
      '[role="menuitemradio"]',
    );
    const selected = levels.indexOf(currentLevel);
    items[last ? items.length - 1 : Math.max(0, selected)]?.focus();
  }
  function closeThinking(restore = false) {
    thinkingOpen = false;
    if (restore) thinkingTrigger?.focus();
  }
  function menuKey(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeThinking(true);
    } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const items = [
        ...thinkingRoot.querySelectorAll<HTMLButtonElement>(
          '[role="menuitemradio"]',
        ),
      ];
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? items.length - 1
            : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) %
              items.length;
      items[next]?.focus();
    }
  }
  async function change(
    kind: 'model' | 'thinking',
    value: string,
  ): Promise<void> {
    if (unavailable) return;
    closeThinking(kind === 'thinking');
    const runtime = desktop.runtimeId;
    const session = desktop.snapshot.sessionFile;
    busy = true;
    error = '';
    try {
      if (kind === 'model') await desktop.setModel(value);
      else {
        await desktop.setThinking(value);
      }
    } catch (cause) {
      if (
        runtime === desktop.runtimeId &&
        session === desktop.snapshot.sessionFile
      )
        error = errorMessage(cause);
    } finally {
      busy = false;
      if (
        kind === 'thinking' &&
        runtime === desktop.runtimeId &&
        session === desktop.snapshot.sessionFile
      )
        thinkingTrigger?.focus();
    }
  }
  $effect(() => {
    desktop.runtimeId;
    desktop.snapshot.sessionFile;
    error = '';
    thinkingOpen = false;
  });
  $effect(() => {
    if (unavailable || levels.length < 2) thinkingOpen = false;
  });
</script>

<svelte:window
  onpointerdown={(event) => {
    if (thinkingOpen && !thinkingRoot?.contains(event.target as Node))
      closeThinking();
  }}
  onblur={() => closeThinking()}
/>

<div
  class="model-controls"
  aria-label="模型与思考"
  role="group"
  aria-busy={busy}
>
  <div class="control-row">
    <ModelPicker
      models={desktop.models}
      current={desktop.selectedModel}
      disabled={unavailable}
      connecting={desktop.connection === 'starting'}
      onselect={(key) => void change('model', key)}
    />
    <div
      class="thinking-root"
      bind:this={thinkingRoot}
      onfocusout={(event) => {
        if (!thinkingRoot.contains(event.relatedTarget as Node))
          closeThinking();
      }}
    >
      <button
        type="button"
        class="control thinking-control"
        class:active={currentLevel !== 'off'}
        bind:this={thinkingTrigger}
        aria-label="思考级别"
        aria-haspopup="menu"
        aria-expanded={thinkingOpen}
        title={`思考强度：${levelInfo(currentLevel).name}（${currentLevel}）`}
        disabled={unavailable || levels.length < 2}
        onclick={() => (thinkingOpen ? closeThinking() : void openThinking())}
        onkeydown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            void openThinking(event.key === 'ArrowUp');
          }
        }}
      >
        <span class="strength" aria-hidden="true">
          {#each [1, 2, 3, 4] as bar}<i
              class:filled={bar <=
                Math.ceil((levelInfo(currentLevel).strength * 4) / 6)}
            ></i>{/each}
        </span>
        <span class="control-caption">思考</span>
        <span class="level-name">{levelInfo(currentLevel).name}</span>
        <span class="thinking-chevron" class:open={thinkingOpen}
          ><Icon name="down" size={12} /></span
        >
      </button>
      {#if thinkingOpen}
        <div
          class="thinking-menu"
          role="menu"
          tabindex="-1"
          aria-label="思考强度"
          onkeydown={menuKey}
        >
          <div class="menu-heading">
            思考强度 <span>更高强度可能需要更长时间</span>
          </div>
          {#each levels as level}
            {@const info = levelInfo(level)}
            <button
              type="button"
              role="menuitemradio"
              aria-checked={currentLevel === level}
              class="thinking-option"
              class:selected={currentLevel === level}
              tabindex="-1"
              onpointerdown={(event) => event.currentTarget.focus()}
              onclick={() => void change('thinking', level)}
            >
              <span class="option-strength" aria-hidden="true"
                >{info.strength === 0 ? '–' : info.strength}</span
              >
              <span class="option-copy"
                ><span class="option-title"
                  >{info.name}<span class="level-code">{level}</span></span
                ><span class="option-hint">{info.hint}</span></span
              >
              <span class="selection-mark"
                >{#if currentLevel === level}<Icon
                    name="check"
                    size={16}
                  />{/if}</span
              >
            </button>
          {/each}
        </div>
      {/if}
    </div>
    {#if busy}<span class="saving" role="status">正在应用…</span
      >{:else if desktop.hasPendingModel}<span class="saving" role="status"
        >下次发送时应用</span
      >{/if}
  </div>
  {#if error}<p class="control-error" role="alert">{error}</p>{/if}
</div>

<style>
  .model-controls {
    min-width: 0;
    max-width: 100%;
  }
  .control-row {
    position: relative;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
  }
  .control {
    display: flex;
    align-items: center;
    position: relative;
    min-width: 0;
    max-width: 100%;
    min-height: 34px;
    border: 1px solid transparent;
    border-radius: 10px;
    background: transparent;
  }
  .control:hover {
    border-color: var(--muted);
  }
  .control:focus-within {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .control:disabled {
    opacity: 0.55;
  }
  .control-caption {
    font-size: 12px;
  }
  .thinking-root {
    position: relative;
  }
  .thinking-control {
    gap: 7px;
    padding: 7px 10px;
    font-size: 13px;
    color: inherit;
  }
  .thinking-control:disabled {
    cursor: default;
  }
  .level-name {
    font-weight: 600;
  }
  .thinking-chevron {
    display: flex;
    color: var(--muted);
  }
  .thinking-chevron.open {
    transform: rotate(180deg);
  }
  .strength {
    display: flex;
    align-items: end;
    gap: 2px;
    height: 14px;
  }
  .strength i {
    width: 3px;
    height: 5px;
    border-radius: 2px;
    background: var(--border);
  }
  .strength i:nth-child(2) {
    height: 8px;
  }
  .strength i:nth-child(3) {
    height: 11px;
  }
  .strength i:nth-child(4) {
    height: 14px;
  }
  .strength i.filled {
    background: var(--accent);
  }
  .thinking-menu {
    position: absolute;
    z-index: 30;
    inset-block-end: calc(100% + 8px);
    inset-inline-end: 0;
    width: min(300px, calc(100vw - 32px));
    max-height: min(480px, 60vh);
    overflow-y: auto;
    padding: 6px;
    border: 1px solid var(--border);
    border-radius: 14px;
    background: var(--bg);
    box-shadow: var(--shadow);
    color: var(--text);
  }
  .menu-heading {
    padding: 8px 9px 10px;
    font-size: 13px;
    font-weight: 600;
  }
  .menu-heading span {
    display: block;
    margin-top: 4px;
    color: var(--muted);
    font-size: 12px;
    font-weight: 400;
  }
  .thinking-option {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 9px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    text-align: start;
    color: inherit;
  }
  .thinking-option:hover,
  .thinking-option:focus-visible {
    background: var(--surface);
  }
  .thinking-option:focus-visible {
    outline-offset: -2px;
  }
  .thinking-option.selected {
    background: var(--accent-soft);
  }
  .option-strength {
    display: grid;
    place-items: center;
    width: 26px;
    height: 28px;
    flex-shrink: 0;
    border: 1px solid var(--border);
    border-radius: 7px;
    font-size: 13px;
    color: var(--muted);
  }
  .selected .option-strength {
    color: var(--accent);
    border-color: var(--accent);
  }
  .option-copy {
    display: grid;
    gap: 3px;
    flex: 1;
  }
  .option-title {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    font-weight: 600;
  }
  .level-code {
    font-size: 12px;
    font-weight: 400;
    color: var(--muted);
  }
  .option-hint {
    font-size: 12px;
    color: var(--muted);
    line-height: 1.5;
  }
  .selection-mark {
    width: 16px;
    color: var(--accent);
  }
  .thinking-control.active {
    background: var(--accent-soft);
    border-color: transparent;
    color: var(--accent);
  }
  .saving {
    font-size: 12px;
    color: var(--muted);
  }
  .control-error {
    margin: 8px 0 0;
    font-size: 13px;
    line-height: 1.5;
    color: var(--error);
    overflow-wrap: anywhere;
  }
  @media (max-width: 600px) {
    .thinking-root {
      position: static;
    }
    .thinking-menu {
      inset-inline-start: 0;
      inset-inline-end: auto;
    }
  }
</style>
