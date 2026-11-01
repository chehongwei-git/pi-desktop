<script lang="ts">
  import { onMount, tick } from 'svelte';
  import type { Desktop } from '../state/desktop.svelte';
  import type { SidebarItem } from '../types';
  import Icon from './Icon.svelte';
  let { desktop, onclose }: { desktop: Desktop; onclose: () => void } =
    $props();
  let search = $state('');
  let kind = $state('all');
  let project = $state('*');
  let limit = $state(50);
  let root = $state<HTMLElement>();
  let heading = $state<HTMLHeadingElement>();
  const categories = [
    { value: 'all', label: '全部' },
    { value: 'project', label: '项目' },
    { value: 'session', label: '会话' },
  ];
  let items = $derived(desktop.archivedItems);
  let projects = $derived.by(() => {
    const groups = new Map<string, string>();
    for (const item of items) {
      const path = desktop.sidebarProject(item);
      groups.set(desktop.projectKey(path), path);
    }
    return [...groups]
      .map(([key, path]) => ({
        key,
        path,
        name: path ? desktop.projectName(path) : '未识别项目',
      }))
      .sort(
        (a, b) =>
          a.name.localeCompare(b.name, 'zh-CN') || a.key.localeCompare(b.key),
      );
  });
  let filtered = $derived(
    items.filter((item) => {
      const path = desktop.sidebarProject(item);
      return (
        (kind === 'all' || item.kind === kind) &&
        (project === '*' || desktop.projectKey(path) === project) &&
        `${desktop.sidebarLabel(item)} ${item.path} ${path} ${path ? desktop.projectName(path) : '未识别项目'}`
          .toLowerCase()
          .includes(search.trim().toLowerCase())
      );
    }),
  );
  let ordered = $derived(
    [...filtered].sort(
      (a, b) =>
        desktop
          .projectKey(desktop.sidebarProject(a))
          .localeCompare(desktop.projectKey(desktop.sidebarProject(b))) ||
        a.kind.localeCompare(b.kind) ||
        desktop
          .sidebarLabel(a)
          .localeCompare(desktop.sidebarLabel(b), 'zh-CN') ||
        a.path.localeCompare(b.path),
    ),
  );
  let groups = $derived.by(() => {
    const result: { key: string; path: string; items: SidebarItem[] }[] = [];
    for (const item of ordered.slice(0, limit)) {
      const path = desktop.sidebarProject(item);
      const key = desktop.projectKey(path);
      let group = result.at(-1);
      if (!group || group.key !== key) {
        group = { key, path, items: [] };
        result.push(group);
      }
      group.items.push(item);
    }
    return result;
  });
  $effect(() => {
    search;
    kind;
    project;
    limit = 50;
  });
  onMount(() => {
    heading?.focus({ preventScroll: true });
  });
  function clear(): void {
    search = '';
    kind = 'all';
    project = '*';
  }
  async function restore(item: SidebarItem): Promise<void> {
    const buttons = [
      ...(root?.querySelectorAll<HTMLButtonElement>('[data-restore]') ?? []),
    ];
    const index = buttons.findIndex(
      (button) => button === document.activeElement,
    );
    try {
      await desktop.manageSidebar(item.kind, item.path, { state: undefined });
      await tick();
      if (index >= 0) {
        const remaining =
          root?.querySelectorAll<HTMLButtonElement>('[data-restore]');
        (remaining?.[Math.min(index, remaining.length - 1)] ?? heading)?.focus({
          preventScroll: true,
        });
      }
    } catch (error) {
      desktop.sidebarError =
        error instanceof Error ? error.message : String(error);
    }
  }
</script>

<section class="collection" aria-label="已归档" bind:this={root}>
  <header>
    <div>
      <p class="eyebrow">历史管理</p>
      <h1 tabindex="-1" bind:this={heading}>
        已归档 <span>{items.length}</span>
      </h1>
    </div>
    <button onclick={onclose}>返回对话</button>
  </header>
  <p class="description">
    暂时收起的项目和会话，按所属项目整理，可随时恢复。归档项目会一并隐藏其会话，原始文件均保留。
  </p>
  <div class="categories" role="group" aria-label="归档分类">
    {#each categories as category}<button
        aria-pressed={kind === category.value}
        onclick={() => {
          kind = category.value;
        }}
        >{category.label}
        <span
          >{items.filter(
            (item) => category.value === 'all' || item.kind === category.value,
          ).length}</span
        ></button
      >{/each}
  </div>
  <div class="filters">
    <div class="search-box">
      <Icon name="search" size={17} /><input
        aria-label="搜索已归档"
        placeholder="搜索名称、项目或路径"
        bind:value={search}
      />
    </div>
    <label
      >所属项目 <select aria-label="所属项目" bind:value={project}
        ><option value="*">全部项目</option>{#each projects as entry}<option
            value={entry.key}
            >{entry.name}{entry.path ? ` · ${entry.path}` : ''}</option
          >{/each}{#if project !== '*' && !projects.some((entry) => entry.key === project)}<option
            value={project}>当前项目（已无归档）</option
          >{/if}</select
      ></label
    >
  </div>
  <div class="results">
    <p class="count" role="status">
      {filtered.length} 项，共 {items.length} 项{filtered.length > limit
        ? ` · 已显示 ${limit} 项`
        : ''}
    </p>
    {#if search || kind !== 'all' || project !== '*'}<button
        class="text-button"
        onclick={clear}>清除筛选</button
      >{/if}
  </div>
  <div aria-busy={desktop.sidebarSaving}>
    {#each groups as group (group.key)}
      <section
        class="project-archive"
        aria-label={`归档项目分组 ${group.path || '未识别项目'}`}
      >
        <h2>
          <Icon name="folder" size={17} />{group.path
            ? desktop.projectName(group.path)
            : '未识别项目'}
          <span
            >{filtered.filter(
              (item) =>
                desktop.projectKey(desktop.sidebarProject(item)) === group.key,
            ).length}</span
          >
        </h2>
        {#if group.path}<p class="group-path">{group.path}</p>{/if}
        <ul>
          {#each group.items as item (`${item.kind}:${item.path}`)}
            {@const parent = desktop.sidebarParent(item)}
            <li>
              <div class="item-icon">
                <Icon name={item.kind === 'project' ? 'folder' : 'chat'} />
              </div>
              <div class="details">
                <div class="item-title">
                  <strong>{desktop.sidebarLabel(item)}</strong><span
                    class="badge"
                    >{item.kind === 'project' ? '项目' : '会话'}</span
                  >
                </div>
                <p class="path">{item.path}</p>
                {#if parent?.state}<p class="parent-hint">
                    所属项目已归档，恢复项目后才会在侧栏显示。
                  </p>{/if}
              </div>
              <button
                data-restore
                aria-label={`恢复${item.kind === 'project' ? '项目' : '会话'} ${desktop.sidebarLabel(item)}`}
                disabled={desktop.sidebarSaving}
                onclick={() => {
                  void restore(item);
                }}>恢复</button
              >
            </li>
          {/each}
        </ul>
      </section>
    {:else}
      <div class="empty">
        <Icon name="folder" size={30} />
        <h2>{items.length ? '没有匹配的内容' : '还没有归档内容'}</h2>
        <p>
          {items.length
            ? '试试其他名称或路径，或切换分类和所属项目。'
            : '在项目或会话的右键菜单中选择“归档”，即可在这里管理。'}
        </p>
      </div>
    {/each}
    {#if filtered.length > limit}<button
        class="load-more"
        onclick={() => {
          limit += 50;
        }}>显示更多（剩余 {filtered.length - limit} 项）</button
      >{/if}
  </div>
</section>

<style>
  .collection {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 34px clamp(16px, 4vw, 40px);
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
  }
  .eyebrow {
    color: var(--muted);
    font-size: 13px;
    margin: 0 0 8px;
  }
  h1 {
    font-size: 28px;
    margin: 0;
  }
  h1 span {
    color: var(--muted);
    font-size: 16px;
    font-weight: normal;
  }
  .description {
    font-size: 14px;
    line-height: 1.7;
    margin: 20px 0 24px;
  }
  .categories {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-bottom: 20px;
  }
  .categories button[aria-pressed='true'] {
    background: var(--accent-soft);
    border-color: var(--accent);
  }
  .categories span {
    margin-left: 6px;
    font-size: 13px;
  }
  .filters {
    display: flex;
    align-items: center;
    gap: 16px;
    flex-wrap: wrap;
  }
  .search-box {
    flex: 1;
    min-width: 160px;
    margin: 0;
  }
  label {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    max-width: 100%;
  }
  select {
    max-width: min(300px, 55vw);
  }
  .results {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin: 20px 0 8px;
  }
  .count {
    font-size: 13px;
    color: var(--muted);
  }
  .project-archive {
    margin-top: 24px;
  }
  .project-archive h2 {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 15px;
    margin: 0;
    overflow-wrap: anywhere;
  }
  h2 span {
    font-size: 13px;
    font-weight: normal;
  }
  .group-path {
    font-size: 13px;
    overflow-wrap: anywhere;
    margin: 6px 0;
  }
  ul {
    padding: 0;
    margin: 0;
    list-style: none;
  }
  li {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 20px 0;
    border-bottom: 1px solid var(--border);
  }
  .item-icon {
    padding: 10px;
    border-radius: 10px;
    background: var(--surface);
    display: flex;
  }
  .details {
    flex: 1;
    min-width: 0;
  }
  .item-title {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
  }
  strong {
    overflow-wrap: anywhere;
    font-size: 14px;
  }
  .badge {
    font-size: 12px;
    padding: 3px 7px;
    background: var(--surface);
    border-radius: 5px;
  }
  .path {
    overflow-wrap: anywhere;
    font-size: 13px;
    margin: 7px 0 0;
  }
  .parent-hint {
    font-size: 13px;
    line-height: 1.6;
    margin: 8px 0 0;
  }
  .empty {
    display: flex;
    padding: 64px 16px;
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: 12px;
  }
  .empty h2 {
    font-size: 17px;
    margin: 0;
  }
  .empty p {
    font-size: 13px;
    line-height: 1.7;
    max-width: 380px;
    margin: 0;
  }
  .load-more {
    display: block;
    margin: 24px auto;
  }
</style>
