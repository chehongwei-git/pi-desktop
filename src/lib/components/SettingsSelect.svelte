<!-- 设置页选择器：焦点保留在入口，列表在页面内展开，不创建独立弹窗。 -->
<script lang="ts">
  import Icon from './Icon.svelte';
  import { tick } from 'svelte';
  let {
    label,
    accessibleLabel,
    value,
    options,
    onchange,
    disabled = false,
    searchable = false,
  }: {
    label: string;
    /** 重复行使用简短可见标签，并提供包含对象与等级的完整无障碍名称。 */
    accessibleLabel?: string;
    value: string | null;
    options: {
      value: string | null;
      label: string;
      description?: string;
      disabled?: boolean;
    }[];
    disabled?: boolean;
    searchable?: boolean;
    onchange: (value: string | null) => void;
  } = $props();
  const id = $props.id();
  let root: HTMLDivElement;
  let trigger: HTMLButtonElement;
  let list = $state<HTMLDivElement>(undefined!);
  let open = $state(false);
  let active = $state(0);
  let query = $state('');
  let searchInput = $state<HTMLInputElement>();
  const visible = $derived(
    options.filter((option) =>
      `${option.label} ${option.description ?? ''}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
    ),
  );
  const selected = $derived(options.find((option) => option.value === value));
  async function reveal(
    index = visible.findIndex((option) => option.value === value),
  ) {
    if (trigger.matches(':disabled')) return;
    active = Math.max(0, index);
    open = true;
    await tick();
    if (!open || !list) return;
    position();
    // 只滚动选项列表，不能让 scrollIntoView 带动设置页或整个窗口。
    const option = document.getElementById(`${id}-${active}`);
    if (option) {
      const item = option.getBoundingClientRect();
      const box = list.getBoundingClientRect();
      const zoom =
        Number.parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
      const top = box.top + list.clientTop * zoom;
      const bottom = top + list.clientHeight * zoom;
      if (item.top < top) list.scrollTop += (item.top - top) / zoom;
      else if (item.bottom > bottom)
        list.scrollTop += (item.bottom - bottom) / zoom;
    }
  }
  /** 固定定位脱离排版；以设置滚动区为边界，避开页头和保存栏。 */
  function position() {
    if (!list || !trigger.isConnected) return;
    const rect = trigger.getBoundingClientRect();
    const container = trigger.closest('.settings-layout, .plugins-scroll');
    const bounds = container?.getBoundingClientRect();
    const top = Math.max(8, bounds?.top ?? 8);
    const bottom = Math.min(
      window.innerHeight - 8,
      bounds?.bottom ?? window.innerHeight - 8,
    );
    if (
      rect.bottom <= top ||
      rect.top >= bottom ||
      trigger.matches(':disabled') ||
      !trigger.getClientRects().length
    ) {
      open = false;
      return;
    }
    // 应用缩放使用 CSS zoom，固定定位的 CSS 像素需从屏幕坐标换算。
    const zoom =
      Number.parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
    const below = Math.max(0, bottom - rect.bottom - 5);
    const above = Math.max(0, rect.top - top - 5);
    const desired = Math.min(240 * zoom, window.innerHeight * 0.35);
    const up =
      below < Math.min(desired, list.scrollHeight * zoom) && above > below;
    const width = Math.min(rect.width, window.innerWidth - 16);
    list.style.width = `${width / zoom}px`;
    list.style.maxHeight = `${Math.min(desired, up ? above : below) / zoom}px`;
    list.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)) / zoom}px`;
    const height = list.getBoundingClientRect().height;
    list.style.top = `${(up ? rect.top - 5 - height : rect.bottom + 5) / zoom}px`;
  }
  $effect(() => {
    if (!open || !list) return;
    position();
    const scroll = (event: Event) => {
      if (event.target instanceof Node && list.contains(event.target)) return;
      position();
    };
    // 仅展开期间监听，关闭或卸载时全部释放，不安装常驻测量循环。
    document.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', position);
    const resize = new ResizeObserver(position);
    resize.observe(trigger);
    const container = trigger.closest('.settings-layout, .plugins-scroll');
    if (container) resize.observe(container);
    return () => {
      document.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', position);
      resize.disconnect();
    };
  });
  function choose(index: number) {
    const option = visible[index];
    if (!option || option.disabled || trigger.matches(':disabled')) return;
    onchange(option.value);
    open = false;
    trigger.focus({ preventScroll: true });
  }
  function keydown(event: KeyboardEvent) {
    if (event.isComposing) return;
    // 搜索输入保留空格和光标首尾操作；方向键和 Enter 才用于候选选择。
    if (
      event.target === searchInput &&
      [' ', 'Home', 'End'].includes(event.key)
    )
      return;
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      event.stopPropagation();
      open = false;
      trigger.focus({ preventScroll: true });
    } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      if (!open)
        void reveal(
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? visible.length - 1
              : undefined,
        );
      else {
        const direction =
          event.key === 'ArrowUp' || event.key === 'End' ? -1 : 1;
        let next =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? visible.length - 1
              : active + direction;
        while (next >= 0 && next < visible.length && visible[next].disabled)
          next += direction;
        if (next >= 0 && next < visible.length) void reveal(next);
      }
    } else if (open && ['Enter', ' '].includes(event.key)) {
      event.preventDefault();
      choose(active);
    } else if (event.key === 'Tab') open = false;
  }
</script>

<svelte:window
  onpointerdown={(event) => {
    if (open && !root.contains(event.target as Node)) open = false;
  }}
  onblur={() => (open = false)}
/>
<div class="settings-select" bind:this={root}>
  <span id={`${id}-label`} class="field-label">{label}</span>
  <button
    bind:this={trigger}
    type="button"
    role="combobox"
    aria-label={accessibleLabel}
    aria-labelledby={accessibleLabel ? undefined : `${id}-label`}
    aria-expanded={open}
    aria-controls={open ? `${id}-list` : undefined}
    aria-activedescendant={open ? `${id}-${active}` : undefined}
    aria-haspopup="listbox"
    class="select-trigger"
    {disabled}
    onkeydown={keydown}
    onclick={() => {
      if (open) open = false;
      else {
        query = '';
        void reveal().then(() => {
          if (searchable) searchInput?.focus({ preventScroll: true });
        });
      }
    }}
    onblur={(event) => {
      if (!root.contains(event.relatedTarget as Node)) open = false;
    }}
    ><span class="selected-label">{selected?.label ?? '请选择'}</span><span
      class="chevron"
      aria-hidden="true"><Icon name="down" size={15} /></span
    ></button
  >
  {#if open}
    <div
      bind:this={list}
      id={`${id}-list`}
      role="listbox"
      aria-label={accessibleLabel}
      aria-labelledby={accessibleLabel ? undefined : `${id}-label`}
      class="select-options"
    >
      {#if searchable}<div class="option-search">
          <input
            bind:this={searchInput}
            value={query}
            aria-label={`搜索${label}`}
            oninput={(event) => {
              query = event.currentTarget.value;
              active = 0;
              void tick().then(position);
            }}
            onkeydown={keydown}
            onblur={(event) => {
              if (!root.contains(event.relatedTarget as Node)) open = false;
            }}
            placeholder="搜索名称或路径…"
          />
        </div>{/if}
      {#each visible as option, index}
        <button
          id={`${id}-${index}`}
          type="button"
          role="option"
          aria-selected={option.value === value}
          disabled={option.disabled}
          tabindex="-1"
          class:active={index === active}
          onpointerdown={(event) => event.preventDefault()}
          onpointermove={() => {
            if (!option.disabled) active = index;
          }}
          onclick={() => choose(index)}
          ><span class="option-copy"
            ><span>{option.label}</span>{#if option.description}<small
                >{option.description}</small
              >{/if}</span
          ><span class="check-slot" aria-hidden="true"
            >{#if option.value === value}<Icon
                name="check"
                size={16}
              />{/if}</span
          ></button
        >
      {:else}<p class="no-options" role="status">没有匹配的选项</p>{/each}
    </div>
  {/if}
</div>

<style>
  .settings-select {
    min-width: 0;
    margin: 0;
    font-size: 12px;
  }
  .field-label {
    display: block;
    margin-bottom: 6px;
  }
  .select-trigger {
    width: 100%;
    min-height: 40px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 9px 12px;
    border: 1px solid var(--border);
    border-radius: 9px;
    background: var(--surface);
    text-align: left;
    font-size: 13px;
  }
  .select-trigger:hover:not(:disabled),
  .select-trigger[aria-expanded='true'] {
    border-color: var(--accent);
  }
  .select-trigger:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .select-trigger:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .selected-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .option-copy {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .option-copy small {
    color: var(--muted);
    font-weight: 400;
    font-size: 11px;
    line-height: 1.5;
    overflow-wrap: anywhere;
  }
  .check-slot {
    flex-shrink: 0;
    width: 16px;
    display: flex;
    align-items: center;
  }
  .option-search {
    position: sticky;
    top: -4px;
    background: var(--surface);
    padding: 4px 4px 9px;
    z-index: 1;
  }
  .option-search input {
    width: 100%;
    min-width: 0;
    border: 1px solid var(--border);
    border-radius: 7px;
    background: var(--bg);
    color: var(--text);
    padding: 8px 10px;
    font: inherit;
  }
  .no-options {
    color: var(--muted);
    text-align: center;
    font-size: 12px;
    margin: 16px 8px;
  }
  .chevron {
    color: var(--muted);
    font-size: 18px;
  }
  /* 固定浮层不占布局高度，也不扩展设置页的滚动范围。 */
  .select-options {
    position: fixed;
    z-index: 100;
    box-sizing: border-box;
    margin: 0;
    padding: 4px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--surface);
    box-shadow: var(--shadow);
    max-height: 240px;
    max-height: min(240px, 35dvh);
    overflow-y: auto;
    overscroll-behavior: contain;
  }
  .select-options button {
    width: 100%;
    min-height: 36px;
    display: flex;
    justify-content: space-between;
    gap: 12px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    text-align: left;
    padding: 8px 10px;
    font-size: 13px;
    overflow-wrap: anywhere;
  }
  .select-options button.active {
    background: var(--accent-soft);
  }
  .select-options button[aria-selected='true'] {
    color: var(--accent);
    font-weight: 600;
  }
</style>
