<!-- 模型选择在输入区内完成；搜索只筛选目录，不修改当前会话或草稿。 -->
<script lang="ts">
  import { tick } from 'svelte';
  import type { Model } from '../types';
  import Icon from './Icon.svelte';

  let {
    models,
    current,
    disabled = false,
    connecting = false,
    onselect,
  }: {
    models: Model[];
    current?: Model;
    disabled?: boolean;
    connecting?: boolean;
    onselect: (key: string) => void;
  } = $props();
  let expanded = $state(false);
  let search = $state('');
  let limit = $state(80);
  let root: HTMLDivElement;
  let trigger: HTMLButtonElement;
  let input = $state<HTMLInputElement>();
  const panelId = $props.id();
  const key = (model: Model) => `${model.provider}/${model.id}`;
  const matches = $derived.by(() => {
    const query = search.trim().toLowerCase();
    const catalog =
      current && !models.some((model) => key(model) === key(current))
        ? [current, ...models]
        : models;
    return catalog
      .filter((model) =>
        `${model.name} ${model.id} ${model.provider}`
          .toLowerCase()
          .includes(query),
      )
      .sort(
        (a, b) =>
          a.provider.localeCompare(b.provider) ||
          a.name.localeCompare(b.name) ||
          a.id.localeCompare(b.id),
      );
  });
  const groups = $derived.by(() => {
    const result = new Map<string, Model[]>();
    for (const model of matches.slice(0, limit)) {
      const group = result.get(model.provider);
      if (group) group.push(model);
      else result.set(model.provider, [model]);
    }
    return [...result].map(([provider, items]) => ({ provider, items }));
  });
  function close(restore = false) {
    expanded = false;
    if (restore) trigger?.focus();
  }
  async function open() {
    if (disabled) return;
    search = '';
    limit = 80;
    expanded = true;
    await tick();
    input?.focus();
  }
  function select(model: Model) {
    close(true);
    if (!current || key(model) !== key(current)) onselect(key(model));
  }
  // 原生输入与按钮保持 Tab 顺序；方向键可跨分组导航，IME 确认不触发选择。
  function keydown(event: KeyboardEvent) {
    if (!expanded || !root.contains(event.target as Node)) return;
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.target === input && event.key === 'Enter') {
      event.preventDefault();
      if (matches[0]) select(matches[0]);
    } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      if (event.target === input && ['Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const controls = [
        input,
        ...root.querySelectorAll<HTMLButtonElement>('.model-panel button'),
      ];
      const index = controls.indexOf(
        document.activeElement as HTMLInputElement,
      );
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? controls.length - 1
            : (index + (event.key === 'ArrowDown' ? 1 : -1) + controls.length) %
              controls.length;
      controls[next]?.focus();
      controls[next]?.scrollIntoView?.({ block: 'nearest' });
    }
  }
  $effect(() => {
    if (disabled) close();
  });
</script>

<svelte:window
  onpointerdown={(event) => {
    if (expanded && !root.contains(event.target as Node)) close();
  }}
  onblur={() => close()}
  onkeydown={keydown}
/>
<div
  class="model-picker"
  bind:this={root}
  onfocusout={(event) => {
    if (!root.contains(event.relatedTarget as Node)) close();
  }}
>
  <button
    type="button"
    class="model-trigger"
    bind:this={trigger}
    {disabled}
    aria-label="模型"
    aria-expanded={expanded}
    aria-controls={expanded ? panelId : undefined}
    title={current ? key(current) : '选择模型'}
    onclick={() => (expanded ? close() : void open())}
    onkeydown={(event) => {
      if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
        event.preventDefault();
        void open();
      }
    }}
  >
    <Icon name="pi" size={16} />
    <span class="trigger-name"
      >{current?.name ||
        current?.id ||
        (connecting ? '正在连接…' : '选择模型')}</span
    >
    {#if current}<span class="provider-badge">{current.provider}</span>{/if}
    <span class="chevron" class:open={expanded}
      ><Icon name="down" size={12} /></span
    >
  </button>
  {#if expanded}
    <div class="model-panel" id={panelId} role="region" aria-label="选择模型">
      <div class="panel-heading">
        <strong>选择模型</strong><span role="status"
          >{matches.length} 个模型</span
        >
      </div>
      <label class="model-search"
        ><Icon name="search" size={15} />
        <input
          bind:this={input}
          bind:value={search}
          oninput={() => (limit = 80)}
          aria-label="搜索模型"
          placeholder="搜索模型或服务商…"
          autocomplete="off"
          spellcheck="false"
        />
      </label>
      <div class="model-list">
        {#each groups as group (group.provider)}
          <section aria-label={group.provider}>
            <div class="group-heading">
              {group.provider}<span>{group.items.length}</span>
            </div>
            {#each group.items as model (model.id)}
              {@const selected = !!current && key(model) === key(current)}
              <button
                type="button"
                class="model-option"
                class:selected
                aria-pressed={selected}
                title={key(model)}
                onmousedown={(event) => {
                  // WebKit 鼠标点击按钮不自动聚焦，先转移焦点以免 focusout 提前卸载选项。
                  event.preventDefault();
                  event.currentTarget.focus({ preventScroll: true });
                }}
                onclick={() => select(model)}
              >
                <span class="model-copy"
                  ><strong>{model.name || model.id}</strong><small
                    >{model.id}</small
                  ></span
                >
                {#if selected}<span class="current-mark"
                    >当前<Icon name="check" size={15} /></span
                  >{/if}
              </button>
            {/each}
          </section>
        {:else}<p class="empty">
            {search.trim()
              ? '没有匹配的模型，试试其他名称或服务商。'
              : '暂无可用模型，请在设置中配置服务商。'}
          </p>{/each}
        {#if matches.length > limit}<button
            type="button"
            class="load-more"
            onclick={() => (limit += 80)}
            >显示更多（剩余 {matches.length - limit} 个）</button
          >{/if}
      </div>
      <div class="panel-hint" aria-hidden="true">
        ↑ ↓ 选择 <span>Enter 确认 · Esc 收起</span>
      </div>
    </div>
  {/if}
</div>

<style>
  .model-picker {
    position: relative;
    min-width: 0;
    max-width: 100%;
  }
  .model-trigger {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 34px;
    max-width: 100%;
    padding: 7px 10px;
    border-radius: 10px;
    border-color: transparent;
    background: transparent;
    font-size: 13px;
  }
  .model-trigger > :global(svg) {
    color: var(--accent);
    flex-shrink: 0;
  }
  .trigger-name {
    max-width: 210px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 500;
  }
  .provider-badge {
    max-width: 90px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--muted);
    font-size: 12px;
    padding: 0;
    border-radius: 4px;
    background: transparent;
  }
  .chevron {
    display: flex;
    color: var(--muted);
  }
  .chevron.open {
    transform: rotate(180deg);
  }
  .model-panel {
    position: absolute;
    z-index: 30;
    inset-block-end: calc(100% + 8px);
    inset-inline-start: 0;
    width: min(380px, calc(100vw - 64px));
    max-height: min(520px, 65vh);
    display: flex;
    flex-direction: column;
    padding: 10px;
    border: 1px solid var(--border);
    border-radius: 14px;
    background: var(--bg);
    box-shadow: var(--shadow);
  }
  .panel-heading {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 3px 3px 10px;
    font-size: 13px;
  }
  .panel-heading > span {
    color: var(--muted);
    font-size: 12px;
  }
  .model-search {
    display: flex;
    align-items: center;
    gap: 7px;
    padding-inline: 9px;
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--muted);
  }
  .model-search:focus-within {
    border-color: var(--accent);
  }
  .model-search input {
    width: 100%;
    padding: 9px 0;
    border: 0;
    background: transparent;
    font-size: 13px;
    outline: none;
  }
  .model-list {
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    margin-top: 8px;
  }
  .group-heading {
    position: sticky;
    top: 0;
    z-index: 1;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 9px 7px;
    background: var(--bg);
    color: var(--muted);
    font-size: 12px;
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .group-heading span {
    padding: 1px 5px;
    border-radius: 5px;
    background: var(--surface);
    font-weight: 400;
  }
  .model-option {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 8px;
    border: 0;
    border-radius: 8px;
    padding: 9px;
    text-align: start;
  }
  .model-option.selected {
    background: var(--accent-soft);
  }
  .model-option:focus-visible {
    outline-offset: -2px;
  }
  .model-copy {
    display: grid;
    gap: 4px;
    min-width: 0;
    flex: 1;
  }
  .model-copy strong {
    font-size: 13px;
    font-weight: 500;
    overflow-wrap: anywhere;
  }
  .model-copy small {
    color: var(--muted);
    font-size: 12px;
    overflow-wrap: anywhere;
  }
  .current-mark {
    display: flex;
    align-items: center;
    gap: 5px;
    color: var(--accent);
    font-size: 12px;
    flex-shrink: 0;
  }
  .panel-hint {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    padding: 10px 3px 1px;
    border-top: 1px solid var(--border);
    margin-top: 7px;
    font-size: 12px;
    color: var(--muted);
  }
  .empty {
    padding: 18px 8px;
    font-size: 13px;
    color: var(--muted);
    line-height: 1.6;
  }
  .load-more {
    width: 100%;
    font-size: 13px;
    margin-block: 6px;
  }
  @media (max-width: 600px) {
    .trigger-name {
      max-width: 160px;
    }
    .provider-badge {
      max-width: 65px;
    }
  }
</style>
