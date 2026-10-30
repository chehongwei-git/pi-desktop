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
    onselect(path);
  }
  function keydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && expanded) {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    }
    if (expanded && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
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
      controls[
        (index + (event.key === 'ArrowDown' ? 1 : controls.length - 1)) %
          controls.length
      ]?.focus();
    }
  }
</script>

<svelte:window
  onpointerdown={(event) => {
    if (expanded && !root.contains(event.target as Node)) close();
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
    class="project-picker-trigger"
    bind:this={trigger}
    {disabled}
    aria-label="选择新对话项目"
    aria-expanded={expanded}
    aria-controls="new-chat-projects"
    title={project || '不在此项目工作 · 用户目录'}
    onclick={async () => {
      expanded = !expanded;
      if (expanded) {
        search = '';
        await tick();
        input?.focus();
      }
    }}
  >
    <Icon name="folder" size={16} />
    <span
      >{project
        ? project.split(/[\\/]/).filter(Boolean).at(-1)
        : '不在此项目工作'}</span
    >
    <Icon name="down" size={13} />
  </button>
  {#if expanded}
    <div
      class="project-picker-panel"
      id="new-chat-projects"
      role="region"
      aria-label="新对话项目"
    >
      <div class="search-box">
        <Icon name="search" size={16} /><input
          bind:this={input}
          bind:value={search}
          aria-label="搜索项目"
          placeholder="搜索项目"
        />
      </div>
      <div class="project-picker-list">
        {#each matches as item (item.path)}
          <button
            class:selected={item.path === project}
            aria-pressed={item.path === project}
            title={item.path}
            onclick={() => select(item.path)}
          >
            <Icon name="folder" size={16} /><span
              ><strong>{item.path.split(/[\\/]/).filter(Boolean).at(-1)}</strong
              ><small>{item.path}</small></span
            >
          </button>
        {:else}<p class="history-empty">没有匹配的项目</p>{/each}
      </div>
      <div class="project-picker-footer">
        <button
          onclick={() => {
            close(true);
            oncreate();
          }}
          ><Icon name="plus" size={16} /><span
            >新建项目<small>选择工作目录</small></span
          ></button
        >
        <button onclick={() => select('')}
          ><Icon name="folder" size={16} /><span
            >不在此项目工作<small>在用户目录下开始对话</small></span
          ></button
        >
      </div>
    </div>
  {/if}
</div>
