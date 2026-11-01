<!-- 设置页选择器：焦点保留在入口，列表在页面内展开，不创建独立弹窗。 -->
<script lang="ts">
  import { tick } from 'svelte';
  let {
    label,
    accessibleLabel,
    value,
    options,
    onchange,
  }: {
    label: string;
    /** 重复行使用简短可见标签，并提供包含对象与等级的完整无障碍名称。 */
    accessibleLabel?: string;
    value: string | null;
    options: { value: string | null; label: string; disabled?: boolean }[];
    onchange: (value: string | null) => void;
  } = $props();
  const id = $props.id();
  let root: HTMLDivElement;
  let trigger: HTMLButtonElement;
  let list = $state<HTMLDivElement>(undefined!);
  let open = $state(false);
  let active = $state(0);
  const selected = $derived(options.find((option) => option.value === value));
  async function reveal(
    index = options.findIndex((option) => option.value === value),
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
    const container = trigger.closest('.settings-layout');
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
    const container = trigger.closest('.settings-layout');
    if (container) resize.observe(container);
    return () => {
      document.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', position);
      resize.disconnect();
    };
  });
  function choose(index: number) {
    const option = options[index];
    if (!option || option.disabled || trigger.matches(':disabled')) return;
    onchange(option.value);
    open = false;
    trigger.focus({ preventScroll: true });
  }
  function keydown(event: KeyboardEvent) {
    if (event.isComposing) return;
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      event.stopPropagation();
      open = false;
    } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      if (!open)
        void reveal(
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? options.length - 1
              : undefined,
        );
      else {
        const direction =
          event.key === 'ArrowUp' || event.key === 'End' ? -1 : 1;
        let next =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? options.length - 1
              : active + direction;
        while (next >= 0 && next < options.length && options[next].disabled)
          next += direction;
        if (next >= 0 && next < options.length) void reveal(next);
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
    onkeydown={keydown}
    onclick={() => {
      if (open) open = false;
      else void reveal();
    }}
    onblur={() => (open = false)}
    ><span>{selected?.label ?? '请选择'}</span><span
      class="chevron"
      aria-hidden="true">⌄</span
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
      {#each options as option, index}
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
          ><span>{option.label}</span><span aria-hidden="true"
            >{option.value === value ? '✓' : ''}</span
          ></button
        >
      {/each}
    </div>
  {/if}
</div>

<style>
  .settings-select {
    min-width: 0;
    margin: 8px 0;
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
    box-shadow: 0 4px 14px #0001;
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
