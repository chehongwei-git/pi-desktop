<script lang="ts">
  import { tick } from 'svelte';
  import Icon from './Icon.svelte';
  let {
    projects,
    project,
    disabled = false,
    onselect,
    oncreate,
  }: {
    projects: { path: string }[];
    project: string;
    disabled?: boolean;
    onselect: (path: string) => void;
    oncreate: () => void;
  } = $props();
  let expanded = $state(false);
  let search = $state('');
  let root: HTMLDivElement;
  let trigger: HTMLButtonElement;
  let input = $state<HTMLInputElement>();
  const panelId = $props.id();
  const projectName = (path: string) =>
    path.split(/[\\/]/).filter(Boolean).at(-1) || path;
  let matches = $derived(
    projects.filter(({ path }) =>
      path.toLowerCase().includes(search.trim().toLowerCase()),
    ),
  );
  function close(restore = false): void {
    expanded = false;
    if (restore) trigger.focus();
  }
  function select(path: string): void {
    close(true);
    if (path !== project) onselect(path);
  }
  async function open(): Promise<void> {
    if (disabled) return;
    expanded = true;
    search = '';
    await tick();
    input?.focus();
  }
  function keydown(event: KeyboardEvent): void {
    if (!root.contains(event.target as Node)) return;
    if (event.isComposing || event.keyCode === 229) return;
    if (!expanded) {
      if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
        event.preventDefault();
        void open();
      }
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.target === input && event.key === 'Enter') {
      event.preventDefault();
      if (matches.length) select(matches[0].path);
      return;
    }
    if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault();
      const controls = [
        input,
        ...root.querySelectorAll<HTMLButtonElement>(
          '.project-picker-panel button',
        ),
      ];
      const index = controls.indexOf(
        document.activeElement as HTMLInputElement,
      );
      const next =
        controls[
          (index + (event.key === 'ArrowDown' ? 1 : controls.length - 1)) %
            controls.length
        ];
      next?.focus();
      next?.scrollIntoView?.({ block: 'nearest' });
    }
  }
</script>

<svelte:window
  onpointerdown={(event) => {
    if (expanded && !root.contains(event.target as Node)) close();
  }}
  onmousedown={(event) => {
    if (!expanded || event.button !== 0) return;
    const button = (event.target as Element).closest('button');
    if (!button || !root.contains(button)) return;
    // WebKit 默认不聚焦鼠标点击的按钮，会先触发 relatedTarget=null 的
    // focusout 并卸载面板。显式移交焦点，让 click 在面板关闭前执行。
    event.preventDefault();
    button.focus({ preventScroll: true });
  }}
  onkeydown={keydown}
/>
<div
  class="project-picker"
  bind:this={root}
  onfocusout={(event) => {
    if (!root.contains(event.relatedTarget as Node)) close();
  }}
>
  <button
    type="button"
    class="project-picker-trigger"
    bind:this={trigger}
    {disabled}
    aria-label="选择新对话项目"
    aria-expanded={expanded}
    aria-controls={expanded ? panelId : undefined}
    title={project || '不在此项目工作 · 用户目录'}
    onclick={() => {
      if (expanded) close();
      else void open();
    }}
  >
    <Icon name="folder" size={15} />
    <span>{project ? projectName(project) : '不在此项目工作'}</span>
    <span class="project-picker-chevron"><Icon name="down" size={13} /></span>
  </button>
  {#if expanded}
    <div
      class="project-picker-panel"
      id={panelId}
      role="region"
      aria-label="新对话项目"
    >
      <div class="project-picker-heading">
        <strong>选择工作项目</strong>
        <span>为这次对话指定工作目录</span>
      </div>
      <div class="search-box">
        <Icon name="search" size={16} /><input
          bind:this={input}
          bind:value={search}
          aria-label="搜索项目"
          placeholder="搜索项目名称或路径…"
          autocomplete="off"
          spellcheck="false"
        />
      </div>
      <div class="project-picker-section">
        <span>{search.trim() ? '搜索结果' : '工作项目'}</span>
        <span role="status">{matches.length} 个项目</span>
      </div>
      <div class="project-picker-list">
        {#each matches as item (item.path)}
          <button
            type="button"
            class="project-picker-item"
            class:selected={item.path === project}
            aria-pressed={item.path === project}
            title={item.path}
            onclick={() => select(item.path)}
          >
            <span class="project-picker-icon"
              ><Icon name="folder" size={18} /></span
            >
            <span class="project-picker-copy">
              <strong>{projectName(item.path)}</strong>
              <small>{item.path}</small>
            </span>
            {#if item.path === project}
              <span class="project-picker-current"
                >当前<Icon name="check" size={15} /></span
              >
            {/if}
          </button>
        {:else}
          <div class="project-picker-empty">
            <Icon name="search" size={22} />
            <strong
              >{search.trim() ? '没有找到匹配项目' : '还没有工作项目'}</strong
            >
            <span
              >{search.trim()
                ? '试试其他名称或路径，也可以选择新的目录。'
                : '选择一个目录，开始你的第一个项目。'}</span
            >
          </div>
        {/each}
      </div>
      <div class="project-picker-footer">
        <button
          type="button"
          onclick={() => {
            close(true);
            oncreate();
          }}
          ><span class="project-picker-action-icon"
            ><Icon name="plus" size={17} /></span
          >
          <span class="project-picker-copy"
            >新建项目<small>选择本地文件夹作为工作目录</small></span
          >
        </button>
        <button
          type="button"
          class:selected={!project}
          aria-pressed={!project}
          onclick={() => select('')}
          ><span class="project-picker-action-icon"
            ><Icon name="chat" size={17} /></span
          >
          <span class="project-picker-copy"
            >不在此项目工作<small>在用户目录下开始对话</small></span
          >
          {#if !project}<Icon name="check" size={16} />{/if}
        </button>
      </div>
      <div class="project-picker-hint" aria-hidden="true">
        ↑ ↓ 选择 <span>Enter 确认 · Esc 收起</span>
      </div>
    </div>
  {/if}
</div>
