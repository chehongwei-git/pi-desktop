<!-- 主工作区：可排序项目侧栏、会话、输入与状态；业务副作用经过 Desktop 门面。 -->
<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { open } from '@tauri-apps/plugin-dialog';
  import { getCurrentWebview } from '@tauri-apps/api/webview';
  import { isTauri } from '@tauri-apps/api/core';
  import { Workspace } from './lib/state/workspace.svelte';
  import { listen } from '@tauri-apps/api/event';
  import { errorMessage } from './lib/client';
  import type { Message, SidebarSessionEntry } from './lib/types';
  import ProjectPicker from './lib/components/ProjectPicker.svelte';
  import CommandComposer from './lib/components/CommandComposer.svelte';
  import Icon from './lib/components/Icon.svelte';
  import Transcript from './lib/components/Transcript.svelte';
  import { conversationActivity } from './lib/conversation-activity';
  import Modal from './lib/components/Modal.svelte';
  import SettingsDialog from './lib/components/SettingsDialog.svelte';
  import ExtensionDialog from './lib/components/ExtensionDialog.svelte';
  import BuiltinCommandDialog from './lib/components/BuiltinCommandDialog.svelte';
  import SidebarSession from './lib/components/SidebarSession.svelte';
  import SidebarRename from './lib/components/SidebarRename.svelte';
  import type { SidebarItem } from './lib/types';
  import SidebarContextMenu from './lib/components/SidebarContextMenu.svelte';
  import SidebarCollection from './lib/components/SidebarCollection.svelte';
  import MessageNotice from './lib/components/MessageNotice.svelte';
  import ContextUsage from './lib/components/ContextUsage.svelte';
  import PlanTodos from './lib/components/PlanTodos.svelte';
  const workspace = new Workspace();
  let desktop = $derived(workspace.active);
  $effect(() => {
    if (workspace.error) {
      desktop.error = workspace.error;
      workspace.error = '';
    }
  });
  let exitPrimary = $state<HTMLButtonElement>();
  let exitReturn: HTMLElement | null = null;
  $effect(() => {
    if (workspace.exitRequested) {
      exitReturn =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      void tick().then(() => exitPrimary?.focus({ preventScroll: true }));
    } else if (exitReturn?.isConnected) {
      exitReturn.focus({ preventScroll: true });
      exitReturn = null;
    }
  });
  let noticesExpanded = $state(false);
  let noticeCount = $derived(
    Number(!!desktop.error) +
      Number(!!(desktop.sidebarError || desktop.sidebarFeedback)) +
      Number(!!desktop.notice),
  );
  // 需要操作的故障优先展示，普通提示折叠后暂停计时，避免未读即消失。
  let primaryNotice = $derived(
    desktop.error
      ? 'error'
      : desktop.sidebarError
        ? 'sidebar'
        : desktop.notice && desktop.run === 'aborting'
          ? 'notice'
          : desktop.sidebarFeedback
            ? 'sidebar'
            : 'notice',
  );
  $effect(() => {
    if (noticeCount === 0) noticesExpanded = false;
  });
  let feedbackOpen = $state(false);
  let feedbackTrigger = $state<HTMLButtonElement>();
  let feedbackBack = $state<HTMLButtonElement>();
  let feedbackHovered = $state(false);
  let feedbackFocused = $state(false);
  let feedbackText = $derived(
    primaryNotice === 'error'
      ? desktop.error
      : primaryNotice === 'sidebar'
        ? desktop.sidebarError || desktop.sidebarFeedback
        : desktop.notice,
  );
  $effect(() => {
    if (!noticeCount) feedbackOpen = false;
  });
  /** 详情仅替换顶栏内容，返回时恢复入口，不干预正文与输入焦点。 */
  async function toggleFeedback(open: boolean): Promise<void> {
    feedbackOpen = open;
    await tick();
    if (open) feedbackBack?.focus({ preventScroll: true });
    else feedbackTrigger?.focus({ preventScroll: true });
  }
  function dismissFeedback(): void {
    if (primaryNotice === 'error') desktop.error = '';
    else if (primaryNotice === 'sidebar') {
      desktop.sidebarError = '';
      desktop.sidebarFeedback = '';
      desktop.sidebarUndo = null;
    } else desktop.notice = '';
  }
  let displayProject = $derived(desktop.newChatProject ?? desktop.project);
  let sidebar = $state(true);
  let settingsOpen = $state(false);
  let settingsVisible = $derived(
    settingsOpen || desktop.builtinRequest?.name === 'settings',
  );
  let settingsPage = $state<SettingsDialog>();
  /** 侧栏设置项常驻未保存标记，避免必须先踩坑才发现草稿。 */
  let settingsUnsaved = $state(false);
  /** 管理视图切换先经过设置草稿保护，成功导航时再清理页面状态。 */
  function leaveSettings(action: () => void, target = ''): void {
    if (settingsVisible && settingsPage)
      settingsPage.requestLeave(action, target);
    else action();
  }
  function hideSettings(): void {
    settingsOpen = false;
    settingsUnsaved = false;
    if (desktop.builtinRequest?.name === 'settings')
      desktop.builtinRequest = null;
  }
  let settingsTrigger: HTMLElement | null = null;
  function openSettings(): void {
    if (settingsVisible) return;
    settingsTrigger =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    sidebarCollection = null;
    settingsOpen = true;
    sidebar = window.innerWidth > 900;
  }
  async function closeSettings(): Promise<void> {
    settingsOpen = false;
    settingsUnsaved = false;
    sidebarCollection = null;
    if (desktop.builtinRequest?.name === 'settings')
      desktop.builtinRequest = null;
    await tick();
    const target =
      settingsTrigger?.isConnected &&
      (sidebar || !settingsTrigger.closest('.sidebar'))
        ? settingsTrigger
        : document.querySelector<HTMLElement>('.composer textarea');
    target?.focus({ preventScroll: true });
  }
  let search = $state('');
  let editing = $state<{
    kind: SidebarItem['kind'];
    path: string;
    label: string;
    entry: string;
    origin: HTMLElement;
  } | null>(null);
  let searchCollapsed = $state<string[]>([]);
  let recentLimit = $state(20);
  let projectLimits = $state<Record<string, number>>({});
  let preferencesReady = $state(false);
  let preferenceError = $state('');
  /** 搜索折叠独立于普通浏览偏好。 */
  function isSectionExpanded(key: string, normal: boolean): boolean {
    return searching ? !searchCollapsed.includes(key) : normal;
  }
  function toggleSearch(key: string): void {
    searchCollapsed = searchCollapsed.includes(key)
      ? searchCollapsed.filter((item) => item !== key)
      : [...searchCollapsed, key];
  }
  function toggleSection(
    key: 'pinned' | 'projects' | 'recent',
    event: MouseEvent,
  ): void {
    (event.currentTarget as HTMLElement).focus({ preventScroll: true });
    if (editing) {
      document
        .querySelector<HTMLInputElement>('.sidebar-rename input')
        ?.focus();
      return;
    }
    if (searching) {
      toggleSearch(key);
      return;
    }
    if (key === 'pinned') pinnedOpen = !pinnedOpen;
    if (key === 'projects') {
      projectsOpen = !projectsOpen;
      showAllProjects = false;
    }
    if (key === 'recent') recentOpen = !recentOpen;
  }
  async function setSidebar(open: boolean): Promise<void> {
    if (!open && editing) {
      document
        .querySelector<HTMLInputElement>('.sidebar-rename input')
        ?.focus();
      return;
    }
    sidebar = open;
    await tick();
    (open
      ? searchInput
      : document.querySelector<HTMLElement>(
          '.main-pane [aria-label="展开侧栏"]',
        )
    )?.focus({ preventScroll: true });
  }
  async function finishRename(): Promise<void> {
    const origin = editing?.origin;
    const host = origin?.closest<HTMLElement>('[data-entry]');
    const entry = editing?.entry;
    editing = null;
    await tick();
    const replacement = [
      ...document.querySelectorAll<HTMLElement>('[data-entry]'),
    ].find((node) => node.dataset.entry === entry);
    (origin?.isConnected
      ? origin
      : ((host?.isConnected ? host : replacement)?.querySelector<HTMLElement>(
          '[data-sidebar-kind]',
        ) ?? searchInput)
    )?.focus({ preventScroll: true });
  }
  $effect(() => {
    search;
    searchCollapsed = [];
    recentLimit = 20;
    projectLimits = {};
  });
  /** 界面偏好采用独立存储，搜索不会覆盖正常展开状态。 */
  $effect(() => {
    if (!preferencesReady) return;
    try {
      localStorage.setItem(
        'pi-desktop-sidebar',
        JSON.stringify({
          sidebar,
          pinnedOpen,
          projectsOpen,
          recentOpen,
          expandedProjects: desktop.expandedProjects,
        }),
      );
    } catch {
      preferenceError = '侧栏布局暂时无法保存。';
    }
  });
  let pinnedOpen = $state(true);
  let projectsOpen = $state(true);
  let recentOpen = $state(true);
  let sidebarCollection = $state<'archived' | null>(null);
  let collectionTrigger: HTMLElement | null = null;
  function openCollection(event: MouseEvent, collection: 'archived'): void {
    const trigger = event.currentTarget as HTMLElement;
    leaveSettings(() => {
      hideSettings();
      collectionTrigger = trigger;
      sidebarCollection = collection;
      sidebar = window.innerWidth > 900;
    }, '打开「已归档」');
  }
  async function closeCollection(): Promise<void> {
    sidebarCollection = null;
    await tick();
    if (sidebar) collectionTrigger?.focus({ preventScroll: true });
    else
      document
        .querySelector<HTMLButtonElement>(
          '.conversation-workspace [aria-label="展开侧栏"]',
        )
        ?.focus({ preventScroll: true });
  }
  let showAllProjects = $state(false);
  let draggingProject = $state('');
  let dropProject = $state('');
  let dropAfter = $state(false);
  function clearProjectDrag(): void {
    draggingProject = '';
    dropProject = '';
    dropAfter = false;
  }
  function projectDrop(event: DragEvent, target: string): void {
    event.preventDefault();
    const source = draggingProject;
    const after = dropAfter;
    clearProjectDrag();
    if (source)
      void desktop.guard(() => workspace.moveProject(source, target, after));
  }
  function projectReorderKey(event: KeyboardEvent, path: string): void {
    if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const order = workspace.projects;
    const index = order.findIndex(
      (project) =>
        desktop.projectKey(project.path) === desktop.projectKey(path),
    );
    const after = event.key === 'ArrowDown';
    const target = order[index + (after ? 1 : -1)];
    if (target) {
      const button = event.currentTarget as HTMLButtonElement;
      void desktop.guard(async () => {
        await workspace.moveProject(path, target.path, after);
        await tick();
        button.focus({ preventScroll: true });
      });
    }
  }
  let searching = $derived(!!search.trim());
  function matchesSession(session: SidebarSessionEntry): boolean {
    return `${session.name} ${session.preview} ${desktop.projectName(session.cwd)} ${session.cwd}`
      .toLowerCase()
      .includes(search.trim().toLowerCase());
  }
  let pinnedSessions = $derived(
    workspace.pinnedSessions.filter(matchesSession),
  );
  let recentSessions = $derived(
    workspace.sidebarSessions.filter(matchesSession),
  );
  let searchInput: HTMLInputElement;
  let renameOpen = $state(false);
  let renameValue = $state('');
  let sessionMenu = $state(false);
  let full = $state<{
    message: Message;
    text: string;
    next: number;
    done: boolean;
  } | null>(null);
  let contentLoading = $state(false);
  let themeDark = $state(false);
  let projects = $derived.by(() => {
    const query = search.trim().toLowerCase();
    return workspace.projects
      .map((project) => ({
        ...project,
        sessions: query
          ? project.sessions.filter((session) =>
              `${session.name} ${session.preview} ${desktop.projectName(session.cwd)} ${session.cwd}`
                .toLowerCase()
                .includes(query),
            )
          : project.sessions,
      }))
      .filter((project) => !query || project.sessions.length > 0);
  });
  let visibleProjects = $derived(
    searching || showAllProjects ? projects : projects.slice(0, 5),
  );
  let lastFocus = 0;
  let empty = $derived(
    !desktop.openingSession &&
      (desktop.newChatProject !== null ||
        desktop.transcriptMessages.length === 0),
  );
  // 本地新草稿与会话加载期间不显示后台旧会话的活动。
  let activity = $derived(
    desktop.newChatProject === null && !desktop.openingSession
      ? conversationActivity(
          desktop.run,
          desktop.messages,
          desktop.extensions.length > 0,
        )
      : null,
  );
  onMount(() => {
    try {
      const saved = JSON.parse(
        localStorage.getItem('pi-desktop-sidebar') || 'null',
      );
      if (saved && typeof saved === 'object') {
        if (typeof saved.sidebar === 'boolean') sidebar = saved.sidebar;
        if (typeof saved.pinnedOpen === 'boolean')
          pinnedOpen = saved.pinnedOpen;
        if (typeof saved.projectsOpen === 'boolean')
          projectsOpen = saved.projectsOpen;
        if (typeof saved.recentOpen === 'boolean')
          recentOpen = saved.recentOpen;
        if (Array.isArray(saved.expandedProjects))
          desktop.expandedProjects = saved.expandedProjects.filter(
            (path: unknown) => typeof path === 'string',
          );
      }
    } catch {
      preferenceError = '未能读取侧栏布局，已使用默认布局。';
    }
    preferencesReady = true;
    void workspace.init();
    const stopClose = isTauri()
      ? listen('desktop-close-requested', () => {
          void workspace.requestExit();
        })
      : Promise.resolve(() => {});
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    themeDark = media.matches;
    const change = () => {
      themeDark = media.matches;
    };
    media.addEventListener('change', change);
    return () => {
      media.removeEventListener('change', change);
      workspace.dispose();
      void stopClose.then((stop) => stop());
    };
  });
  $effect(() => {
    document.documentElement.dataset.theme =
      desktop.settings.theme === 'system'
        ? themeDark
          ? 'dark'
          : 'light'
        : desktop.settings.theme;
  });
  let zoomSaving = false;
  function changeZoom(value: number): void {
    const zoom = Math.max(80, Math.min(150, value));
    if (zoomSaving || zoom === desktop.settings.zoom) return;
    zoomSaving = true;
    void desktop.guard(async () => {
      try {
        await desktop.saveSettings({
          ...$state.snapshot(desktop.settings),
          zoom,
        });
      } finally {
        zoomSaving = false;
      }
    });
  }
  $effect(() => {
    const zoom = desktop.settings.zoom / 100;
    if (isTauri()) {
      void getCurrentWebview()
        .setZoom(zoom)
        .catch((error) => {
          desktop.error = errorMessage(error);
        });
    } else {
      document.documentElement.style.zoom = String(zoom);
      document.documentElement.style.setProperty(
        '--preview-zoom',
        String(zoom),
      );
    }
  });
  /** 项目由原生目录选择器授权，不默认使用应用安装目录。 */
  async function chooseProject(): Promise<void> {
    await desktop.guard(async () => {
      const path = await open({
        directory: true,
        multiple: false,
        title: '选择 Pi 工作项目',
      });
      if (typeof path === 'string')
        desktop.requestSwitch('切换项目', () => desktop.connect(path));
    });
  }
  /** 新对话可在输入框上方重新选择工作目录。 */
  function newChat(project = desktop.project): void {
    leaveSettings(() => {
      desktop.requestSwitch('开始新对话', async () => {
        hideSettings();
        sidebarCollection = null;
        desktop.prepareNewChat(project);
      });
    }, '开始新对话');
  }
  function selectNewProject(project: string): void {
    desktop.requestSwitch('选择新对话项目', async () => {
      desktop.prepareNewChat(project, true);
    });
  }
  async function createNewProject(): Promise<void> {
    await desktop.guard(async () => {
      const path = await open({
        directory: true,
        multiple: false,
        title: '选择 Pi 工作项目',
      });
      if (typeof path === 'string') selectNewProject(path);
    });
  }
  /** 复用 Pi 恢复历史；被扩展取消时门面保持原状态。 */
  function selectSession(session: SidebarSessionEntry): void {
    leaveSettings(
      () => {
        desktop.requestSwitch('打开历史会话', async () => {
          await workspace.openEntry(session);
          hideSettings();
          sidebarCollection = null;
          sidebar = window.innerWidth > 900;
        });
      },
      `打开会话「${session.name || session.preview || '新对话'}」`,
    );
  }
  /** 快捷键与普通输入不冲突；原生 dialog 已处理 Escape/焦点约束。 */
  function keydown(event: KeyboardEvent): void {
    if (event.defaultPrevented) return;
    if (
      event.key === 'Escape' &&
      workspace.exitRequested &&
      !workspace.exiting
    ) {
      event.preventDefault();
      workspace.exitRequested = false;
      return;
    }
    if (
      event.key === 'Escape' &&
      sidebar &&
      (document.activeElement as Element)?.closest('.sidebar') &&
      !editing
    ) {
      event.preventDefault();
      if (search) {
        search = '';
        searchInput.focus();
      } else if (window.innerWidth <= 900) void setSidebar(false);
      return;
    }
    if (
      (event.ctrlKey || event.metaKey) &&
      !event.altKey &&
      ['+', '=', '-', '0'].includes(event.key)
    ) {
      event.preventDefault();
      changeZoom(
        event.key === '0'
          ? 100
          : desktop.settings.zoom + (event.key === '-' ? -10 : 10),
      );
      return;
    }
    if (
      !(event.ctrlKey || event.metaKey) ||
      event.altKey ||
      document.querySelector('dialog[open]')
    )
      return;
    const key = event.key.toLowerCase();
    if (['n', 'k', 'b', ','].includes(key)) {
      event.preventDefault();
      if (key === 'n') newChat();
      if (key === 'k') {
        sidebar = true;
        queueMicrotask(() => searchInput?.focus());
      }
      if (key === 'b') void setSidebar(!sidebar);
      if (key === ',') openSettings();
    }
  }
  /** 窗口重获焦点才增量刷新，不创建常驻轮询。 */
  function focus(): void {
    if (Date.now() - lastFocus < 5000) return;
    lastFocus = Date.now();
    void desktop.guard(() => desktop.refreshSessions());
  }
  /** 正文弹层每次只持有一个 64KiB 分块，不把大输出全部搬进 WebView。 */
  async function showFull(message: Message): Promise<void> {
    if (!message.contentRef) return;
    await desktop.guard(async () => {
      const page = await desktop.readContent(message.contentRef!, 0);
      full = { message, ...page };
    });
  }
  /** 下一页覆盖当前页，确保浏览大型输出时内存有界。 */
  async function nextContent(): Promise<void> {
    if (!full?.message.contentRef || contentLoading) return;
    contentLoading = true;
    try {
      const page = await desktop.readContent(
        full.message.contentRef,
        full.next,
      );
      full = { message: full.message, ...page };
    } catch (error) {
      desktop.error = errorMessage(error);
    } finally {
      contentLoading = false;
    }
  }
  /** 复制会话路径仅复制当前 Pi 返回路径。 */
  async function copyPath(): Promise<void> {
    if (desktop.snapshot.sessionFile) {
      await navigator.clipboard.writeText(desktop.snapshot.sessionFile);
      desktop.notice = '会话路径已复制';
    }
    sessionMenu = false;
  }
</script>

<svelte:window onkeydown={keydown} onfocus={focus} />
<SidebarContextMenu
  {desktop}
  onrename={(kind, path, label, origin) => {
    if (editing) {
      document
        .querySelector<HTMLInputElement>('.sidebar-rename input')
        ?.focus();
      return;
    }
    editing = {
      kind,
      path,
      label,
      origin,
      entry: origin.closest<HTMLElement>('[data-entry]')?.dataset.entry ?? '',
    };
  }}
/>
{#snippet sessionItem(
  session: SidebarSessionEntry,
  showProject = false,
  location = 'project',
)}
  <div data-entry={`${location}:${session.id}`}>
    {#if session.path && editing?.kind === 'session' && editing.entry === `${location}:${session.id}`}
      <SidebarRename
        {desktop}
        kind="session"
        path={session.path}
        label={editing.label}
        onclose={() => {
          void finishRename();
        }}
      />
    {:else}
      <SidebarSession
        {session}
        {showProject}
        active={workspace.isSelected(session)}
        pinned={workspace.isPinned(session)}
        busy={desktop.pinSaving}
        onopen={() => selectSession(session)}
        onpin={() => desktop.guard(() => workspace.togglePin(session))}
      />
    {/if}
  </div>
{/snippet}
<div class="app-shell" class:sidebar-hidden={!sidebar}>
  {#if sidebar}<button
      class="sidebar-backdrop"
      aria-label="收起侧栏"
      onclick={() => {
        void setSidebar(false);
      }}
    ></button>{/if}
  <aside class="sidebar" class:open={sidebar} aria-label="项目与历史会话">
    <div class="sidebar-brand">
      <div class="brand-mark"><Icon name="pi" size={23} /></div>
      <strong>Pi Desktop</strong><button
        class="icon-button"
        aria-label="收起侧栏"
        title="Ctrl/Cmd+B"
        onclick={() => {
          void setSidebar(false);
        }}><Icon name="panel" /></button
      >
    </div>
    <button class="nav-new" onclick={() => newChat()}
      ><Icon name="plus" size={19} /><span>新对话</span><kbd>⌘ / Ctrl N</kbd
      ></button
    >
    <div class="search-box">
      <Icon name="search" size={16} /><input
        bind:this={searchInput}
        bind:value={search}
        disabled={!!editing}
        placeholder="搜索会话"
        aria-label="搜索历史会话"
      />
      {#if search}<button
          class="icon-button"
          disabled={!!editing}
          aria-label="清除会话搜索"
          onclick={() => {
            search = '';
            searchInput.focus();
          }}>×</button
        >{/if}
    </div>
    {#if searching}<p class="sidebar-search-summary" role="status">
        搜索结果 · {recentSessions.length} 个会话
      </p>{/if}
    {#if preferenceError}<p class="sidebar-search-summary" role="status">
        {preferenceError}
      </p>{/if}
    <nav
      class="history-list"
      aria-label="项目与历史会话"
      aria-busy={desktop.loadingSessions}
    >
      {#if !searching || pinnedSessions.length > 0}
        <section class="sidebar-section" aria-label="置顶">
          <div class="section-label">
            <button
              class="section-toggle"
              aria-expanded={isSectionExpanded('pinned', pinnedOpen)}
              onclick={(event) => toggleSection('pinned', event)}
            >
              <span
                class="project-chevron"
                class:collapsed={!isSectionExpanded('pinned', pinnedOpen)}
                ><Icon name="down" size={13} /></span
              >
              <span>置顶</span><small>{pinnedSessions.length}</small>
            </button>
          </div>
          {#if isSectionExpanded('pinned', pinnedOpen)}
            {#each pinnedSessions as session (session.id)}
              {@render sessionItem(session, true, 'pinned')}
            {:else}<div class="history-empty">
                {searching ? '没有匹配的置顶会话' : '点击会话旁的图钉置顶'}
              </div>{/each}
          {/if}
        </section>
      {/if}
      {#if !searching || projects.length > 0}
        <section class="sidebar-section" aria-label="工作项目">
          <div class="section-label">
            <button
              class="section-toggle"
              aria-expanded={isSectionExpanded('projects', projectsOpen)}
              onclick={(event) => toggleSection('projects', event)}
            >
              <span
                class="project-chevron"
                class:collapsed={!isSectionExpanded('projects', projectsOpen)}
                ><Icon name="down" size={13} /></span
              >
              <span>工作项目</span><small>{projects.length}</small>
            </button>
            <button
              class="icon-button"
              aria-label="选择项目文件夹"
              onclick={chooseProject}><Icon name="plus" size={15} /></button
            >
          </div>
          {#if isSectionExpanded('projects', projectsOpen)}
            {#each visibleProjects as project (desktop.projectKey(project.path))}
              {@const expanded = isSectionExpanded(
                `project:${project.path}`,
                desktop.isExpanded(project.path),
              )}
              <div class="project-group" data-entry={`project:${project.path}`}>
                {#if editing?.kind === 'project' && editing.path === project.path}
                  <SidebarRename
                    {desktop}
                    kind="project"
                    path={project.path}
                    label={editing.label}
                    onclose={() => {
                      void finishRename();
                    }}
                  />
                {:else}
                  <div class="project-row">
                    <button
                      class="project-current"
                      data-sidebar-kind="project"
                      data-sidebar-path={project.path}
                      data-sidebar-label={desktop.projectName(project.path)}
                      class:active={desktop.projectKey(project.path) ===
                        desktop.projectKey(displayProject)}
                      class:project-dragging={draggingProject === project.path}
                      class:drop-before={dropProject === project.path &&
                        !dropAfter}
                      class:drop-after={dropProject === project.path &&
                        dropAfter}
                      draggable={!desktop.projectOrderSaving}
                      title={project.path + '（拖拽排序，或 Alt+↑/↓）'}
                      ondragstart={(event) => {
                        draggingProject = project.path;
                        event.dataTransfer?.setData('text/plain', project.path);
                        if (event.dataTransfer)
                          event.dataTransfer.effectAllowed = 'move';
                      }}
                      ondragend={clearProjectDrag}
                      ondragover={(event) => {
                        if (!draggingProject || desktop.projectOrderSaving)
                          return;
                        event.preventDefault();
                        if (event.dataTransfer)
                          event.dataTransfer.dropEffect = 'move';
                        const bounds =
                          event.currentTarget.getBoundingClientRect();
                        dropProject = project.path;
                        dropAfter =
                          event.clientY > bounds.top + bounds.height / 2;
                      }}
                      ondragleave={() => {
                        if (dropProject === project.path) dropProject = '';
                      }}
                      ondrop={(event) => projectDrop(event, project.path)}
                      onkeydown={(event) =>
                        projectReorderKey(event, project.path)}
                      aria-expanded={expanded}
                      onclick={(event) => {
                        event.currentTarget.focus({ preventScroll: true });
                        if (editing) {
                          document
                            .querySelector<HTMLInputElement>(
                              '.sidebar-rename input',
                            )
                            ?.focus();
                          return;
                        }
                        if (searching) toggleSearch(`project:${project.path}`);
                        else desktop.toggleProject(project.path);
                      }}
                    >
                      <span class="project-chevron" class:collapsed={!expanded}
                        ><Icon name="down" size={13} /></span
                      >
                      <Icon name="folder" size={17} /><span class="project-name"
                        >{desktop.projectName(project.path)}</span
                      >
                      {#if workspace.projectArchived(project.path)}<small
                          >已归档</small
                        >{/if}
                      <small>{project.sessions.length}</small>
                    </button>
                    <button
                      class="icon-button project-new"
                      aria-label={`在 ${project.path} 中新建会话`}
                      onclick={() => newChat(project.path)}
                      ><Icon name="plus" size={15} /></button
                    >
                    <button
                      class="icon-button sidebar-more"
                      data-sidebar-more
                      aria-haspopup="menu"
                      aria-label={`项目操作 ${desktop.projectName(project.path)}`}
                      title="更多操作"><Icon name="more" size={14} /></button
                    >
                  </div>
                {/if}
                {#if expanded}
                  <div class="project-sessions">
                    {#each project.sessions.slice(0, projectLimits[project.path] ?? 20) as session (session.id)}
                      {@render sessionItem(session)}
                    {:else}<div class="history-empty">
                        暂无会话，点击 + 开始对话
                      </div>{/each}
                    {#if project.sessions.length > (projectLimits[project.path] ?? 20)}
                      <button
                        class="text-button show-more"
                        onclick={() => {
                          projectLimits[project.path] =
                            (projectLimits[project.path] ?? 20) + 20;
                        }}
                        >显示更多会话（剩余 {project.sessions.length -
                          (projectLimits[project.path] ?? 20)}）</button
                      >
                    {/if}
                  </div>
                {/if}
              </div>
            {:else}<div class="history-empty" role="status">
                {desktop.loadingSessions
                  ? '正在加载工作区…'
                  : searching
                    ? '没有匹配的会话'
                    : '还没有 Pi 工作区，可直接新建对话'}
              </div>{/each}
            {#if !searching && projects.length > 5}
              <button
                class="text-button show-more"
                onclick={() => {
                  showAllProjects = !showAllProjects;
                }}
              >
                {showAllProjects
                  ? '收起更多项目'
                  : `显示全部 ${projects.length} 个项目`}
              </button>
            {/if}
          {/if}
        </section>
      {/if}
      {#if !searching || recentSessions.length > 0}
        <section class="sidebar-section" aria-label="最近">
          <div class="section-label">
            <button
              class="section-toggle"
              aria-expanded={isSectionExpanded('recent', recentOpen)}
              onclick={(event) => toggleSection('recent', event)}
            >
              <span
                class="project-chevron"
                class:collapsed={!isSectionExpanded('recent', recentOpen)}
                ><Icon name="down" size={13} /></span
              >
              <span>最近</span><small>{recentSessions.length}</small>
            </button>
          </div>
          {#if isSectionExpanded('recent', recentOpen)}
            {#each recentSessions.slice(0, recentLimit) as session (session.id)}
              {@render sessionItem(session, true, 'recent')}
            {:else}<div class="history-empty">
                {searching ? '没有匹配的会话' : '暂无最近会话'}
              </div>{/each}
            {#if recentSessions.length > recentLimit}<button
                class="text-button show-more"
                onclick={() => {
                  recentLimit += 20;
                }}
                >显示更多会话（剩余 {recentSessions.length -
                  recentLimit}）</button
              >{/if}
          {/if}
        </section>
      {/if}
      {#if searching && recentSessions.length === 0 && projects.length === 0 && pinnedSessions.length === 0}
        <div class="history-empty">
          没有匹配的会话，试试其他名称、项目或路径。
        </div>
      {/if}
    </nav>
    <div class="sidebar-footer">
      <button
        class="sidebar-settings"
        aria-current={sidebarCollection === 'archived' && !settingsVisible
          ? 'page'
          : undefined}
        onclick={(event) => openCollection(event, 'archived')}
        ><Icon name="folder" size={19} /><span>已归档</span></button
      >
      <button
        class="sidebar-settings"
        aria-current={settingsVisible ? 'page' : undefined}
        onclick={openSettings}
        ><Icon name="settings" size={19} /><span>设置</span
        >{#if settingsUnsaved}<small class="unsaved-hint">未保存更改</small
          >{:else}<small>本地 Pi · RPC</small>{/if}</button
      >
    </div>
  </aside>
  <main class="main-pane">
    {#if workspace.exitRequested}
      <div class="queue-hint" role="region" aria-label="退出应用确认">
        <strong
          >有 {workspace.running} 个执行中、{workspace.queued} 个排队任务</strong
        >
        <span>退出会停止所有项目的任务，重启后不会自动重跑。</span>
        <button
          disabled={workspace.exiting}
          onclick={() => (workspace.exitRequested = false)}>继续工作</button
        >
        <button
          bind:this={exitPrimary}
          disabled={workspace.exiting}
          onclick={() => workspace.exit()}>停止任务并退出</button
        >
        {#if workspace.forceExitAvailable}<button
            onclick={() => workspace.exit(true)}>强制停止并退出</button
          >{/if}
      </div>
    {/if}
    {#snippet notices(inHeader = false)}
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions (容器仅接收子控件冒泡的 Escape，入口与返回均为原生按钮。) -->
      <section
        class="notice-stack"
        class:header-feedback={inHeader}
        class:feedback-open={inHeader && feedbackOpen}
        aria-label="消息提示"
        onpointerenter={() => {
          feedbackHovered = true;
        }}
        onpointerleave={() => {
          feedbackHovered = false;
        }}
        onfocusin={() => {
          feedbackFocused = true;
        }}
        onfocusout={(event) => {
          feedbackFocused = event.currentTarget.contains(
            event.relatedTarget as Node,
          );
        }}
        onkeydown={(event) => {
          if (inHeader && event.key === 'Escape') {
            event.preventDefault();
            void toggleFeedback(false);
          }
        }}
      >
        {#if inHeader && noticeCount}
          <div class="feedback-summary" hidden={feedbackOpen}>
            <button
              bind:this={feedbackTrigger}
              class="feedback-trigger"
              aria-label="查看消息提示"
              aria-expanded={feedbackOpen}
              onclick={() => void toggleFeedback(true)}
            >
              <Icon
                name={primaryNotice === 'error' || desktop.run === 'aborting'
                  ? 'warning'
                  : 'info'}
                size={16}
              />
              <span role={primaryNotice === 'error' ? 'alert' : 'status'}
                >{feedbackText}</span
              ><small>{noticeCount}</small>
            </button>
            <button
              class="icon-button"
              aria-label="关闭提示"
              onclick={dismissFeedback}><Icon name="close" size={16} /></button
            >
          </div>
          {#if feedbackOpen}<button
              bind:this={feedbackBack}
              class="text-button feedback-back"
              onclick={() => void toggleFeedback(false)}>返回</button
            >{/if}
        {/if}
        <div class="feedback-details" hidden={inHeader && !feedbackOpen}>
          {#if desktop.error}
            <div hidden={!noticesExpanded && primaryNotice !== 'error'}>
              <MessageNotice
                message={desktop.error}
                title="操作未完成"
                tone="error"
                dismissLabel="关闭错误"
                duration={inHeader &&
                (feedbackOpen || feedbackHovered || feedbackFocused)
                  ? 0
                  : noticesExpanded || primaryNotice === 'error'
                    ? 8000
                    : 0}
                ondismiss={() => {
                  desktop.error = '';
                }}
              >
                {#snippet actions()}
                  {#if desktop.project}<button
                      class="text-button"
                      onclick={() =>
                        desktop.requestSwitch('重新连接', () =>
                          desktop.connect(desktop.project),
                        )}>重新连接</button
                    >{/if}
                  <button class="text-button" onclick={openSettings}
                    >设置</button
                  >
                {/snippet}
              </MessageNotice>
            </div>
          {/if}
          {#if desktop.sidebarFeedback || desktop.sidebarError}
            <div hidden={!noticesExpanded && primaryNotice !== 'sidebar'}>
              <MessageNotice
                message={desktop.sidebarError || desktop.sidebarFeedback}
                title={desktop.sidebarError ? '历史管理未完成' : '历史已更新'}
                tone={desktop.sidebarError ? 'error' : 'success'}
                dismissLabel="关闭历史管理提示"
                duration={(inHeader &&
                  (feedbackOpen || feedbackHovered || feedbackFocused)) ||
                desktop.sidebarSaving ||
                (!noticesExpanded && primaryNotice !== 'sidebar')
                  ? 0
                  : 8000}
                ondismiss={() => {
                  desktop.sidebarFeedback = '';
                  desktop.sidebarError = '';
                  desktop.sidebarUndo = null;
                }}
              >
                {#snippet actions()}
                  {#if desktop.sidebarUndo}<button
                      class="text-button"
                      disabled={desktop.sidebarSaving}
                      onclick={() => {
                        void desktop.undoSidebar().catch((error) => {
                          desktop.sidebarError = errorMessage(error);
                        });
                      }}>{desktop.sidebarSaving ? '正在撤销…' : '撤销'}</button
                    >{/if}
                {/snippet}
              </MessageNotice>
            </div>
          {/if}
          {#if desktop.notice}
            <div hidden={!noticesExpanded && primaryNotice !== 'notice'}>
              <MessageNotice
                message={desktop.notice}
                title={desktop.run === 'aborting'
                  ? '任务仍在停止中'
                  : ['会话路径已复制', '名称已更新'].includes(desktop.notice)
                    ? '操作成功'
                    : '消息提示'}
                tone={desktop.run === 'aborting'
                  ? 'warning'
                  : ['会话路径已复制', '名称已更新'].includes(desktop.notice)
                    ? 'success'
                    : 'info'}
                duration={(inHeader &&
                  (feedbackOpen || feedbackHovered || feedbackFocused)) ||
                (!noticesExpanded && primaryNotice !== 'notice') ||
                desktop.run === 'aborting' ||
                desktop.run === 'compacting'
                  ? 0
                  : 3000}
                ondismiss={() => {
                  desktop.notice = '';
                }}
              >
                {#snippet actions()}
                  {#if desktop.run === 'aborting'}<button
                      class="text-button"
                      onclick={() => {
                        void desktop.guard(() => desktop.disconnect(true));
                      }}>强制关闭</button
                    >{/if}
                {/snippet}
              </MessageNotice>
            </div>
          {/if}
          {#if noticeCount > 1}
            <button
              class="text-button notice-more"
              aria-expanded={noticesExpanded}
              onclick={() => {
                noticesExpanded = !noticesExpanded;
              }}
              >{noticesExpanded
                ? '收起其他提示'
                : `还有 ${noticeCount - 1} 条提示`}</button
            >
          {/if}
        </div>
      </section>
    {/snippet}
    {#if sidebarCollection !== null || settingsVisible}{@render notices()}{/if}
    {#if settingsVisible}
      <SettingsDialog
        bind:this={settingsPage}
        {desktop}
        bind:unsaved={settingsUnsaved}
        onclose={() => {
          void closeSettings();
        }}
      />
    {/if}
    {#if sidebarCollection && !settingsVisible}
      <div class="collection-navigation">
        {#if !sidebar}<button
            class="icon-button"
            aria-label="展开侧栏"
            onclick={() => {
              void setSidebar(true);
            }}><Icon name="panel" /></button
          >{/if}<span>项目与会话</span>
      </div>
      <SidebarCollection
        {desktop}
        onclose={() => {
          void closeCollection();
        }}
      />
    {/if}
    <div
      class="conversation-workspace"
      class:collection-hidden={sidebarCollection !== null || settingsVisible}
      inert={sidebarCollection !== null || settingsVisible}
    >
      <header class="topbar" class:show-feedback={feedbackOpen}>
        <div class="topbar-left">
          {#if !sidebar}<button
              class="icon-button"
              aria-label="展开侧栏"
              onclick={() => {
                void setSidebar(true);
              }}><Icon name="panel" /></button
            >{/if}
          <!-- 当前会话直接作为顶栏主体，减少重复品牌与第二行标题。 -->
          {#if displayProject || desktop.newChatProject !== null || desktop.openingSession}
            <h1 class="session-title" title={desktop.sessionTitle}>
              {desktop.sessionTitle}
            </h1>
          {:else}
            <span class="product-name">Pi</span>
          {/if}
        </div>
        <div class="topbar-right">
          {@render notices(true)}
          <span
            class="connection"
            class:connected={desktop.connection === 'ready'}
            ><span class="status-dot"></span>{desktop.connectionPhase ||
              (desktop.restoring || desktop.connection === 'starting'
                ? '准备中'
                : desktop.connection === 'ready'
                  ? '已连接'
                  : desktop.connection === 'failed'
                    ? '连接失败'
                    : '未连接')}</span
          >
          <div class="session-menu-wrap">
            <button
              class="icon-button"
              aria-label="会话菜单"
              onclick={() => {
                sessionMenu = !sessionMenu;
              }}><Icon name="more" /></button
            >{#if sessionMenu}<div class="session-menu">
                <button
                  disabled={desktop.newChatProject !== null ||
                    !!desktop.openingSession ||
                    !desktop.snapshot.sessionFile}
                  onclick={() => {
                    void desktop.guard(copyPath);
                  }}>复制会话路径</button
                ><button
                  disabled={desktop.newChatProject !== null ||
                    !!desktop.openingSession ||
                    desktop.run !== 'idle' ||
                    !desktop.snapshot.sessionFile}
                  onclick={() => {
                    renameValue = desktop.snapshot.sessionName ?? '';
                    renameOpen = true;
                    sessionMenu = false;
                  }}>重命名当前会话</button
                >
              </div>{/if}
          </div>
        </div>
      </header>
      <div
        class="conversation"
        class:empty
        aria-busy={!!desktop.openingSession}
      >
        {#if desktop.openingSession}
          <div class="session-loading" role="status" aria-label="正在加载会话">
            <span class="loading-indicator" aria-hidden="true"
              ><Icon name="refresh" size={20} /></span
            >
          </div>
        {:else if empty}<div class="welcome">
            <div class="welcome-logo"><Icon name="pi" size={40} /></div>
            <h1>
              {displayProject ? '今天想做些什么？' : '让 Pi 与你的项目一起工作'}
            </h1>
            <p>
              {displayProject
                ? displayProject
                : '直接新建对话，或选择项目文件夹开始。'}
            </p>
            {#if !displayProject}<button
                class="choose-project"
                onclick={chooseProject}
                ><Icon name="folder" size={18} />选择项目文件夹</button
              >{/if}
            <!-- 新草稿在首次发送时自动连接；未分配运行实例不代表连接故障。 -->
            {#if displayProject && desktop.newChatProject === null && (desktop.connection === 'disconnected' || desktop.connection === 'failed')}<button
                class="choose-project"
                onclick={() => {
                  void desktop.connect(desktop.project);
                }}>连接 Pi</button
              >{/if}
          </div>
        {/if}
        {#each workspace.retained as session (session)}
          <div
            class="session-transcript"
            hidden={session !== desktop || empty || !!desktop.openingSession}
          >
            {#if session.transcriptMessages.length}
              <Transcript
                messages={session.transcriptMessages}
                activity={session === desktop ? activity : null}
                active={session === desktop &&
                  !empty &&
                  !desktop.openingSession}
                scrollState={session.scrollState}
                resumeFollow={session.sentMessageRevision}
                hasMore={session.hasMore}
                loading={session.loadingHistory ||
                  session.restoring ||
                  session.connection !== 'ready'}
                oncommit={(handler) => {
                  session.beforeHistoryCommit = handler;
                }}
                onolder={(beforeInsert) =>
                  session.refreshHistory(session.before, beforeInsert)}
                onfull={(message) => {
                  if (session === desktop) void showFull(message);
                }}
                toolViews={session.toolViews}
                ontoggletool={(id, section) => session.toggleTool(id, section)}
                read={(id, offset) => session.readContent(id, offset)}
                onvisible={(ids) => session.pinVisible(ids)}
                onload={(message) => session.loadPreview(message)}
                onerror={(message) => {
                  session.error = message;
                }}
              />
            {/if}
          </div>
        {/each}
        <div class="composer-area">
          {#if desktop.historyCached && desktop.connection === 'failed' && !desktop.restoring}
            <div class="queue-hint" role="status">
              连接恢复失败，已缓存内容仍可阅读。
              <button
                onclick={() =>
                  void desktop.guard(() => workspace.ensure(desktop))}
                >重试连接</button
              >
            </div>
          {/if}
          {#if desktop.extensions[0]}
            {@const request = desktop.extensions[0]}
            {#key `${desktop.runtimeId}:${request.id}`}
              <ExtensionDialog
                {request}
                onrespond={async (value) => {
                  const owner = desktop;
                  await owner.respond(request, value);
                  // 只有写入成功且用户仍在此会话时恢复底部跟随。
                  if (
                    owner === desktop &&
                    !value.cancelled &&
                    (value.value !== undefined || value.confirmed === true)
                  )
                    owner.sentMessageRevision++;
                }}
              />
            {/key}
          {/if}
          <!-- 新对话只是本地草稿，后台扩展状态仍属于原会话；返回时继续展示。 -->
          {#if desktop.newChatProject === null && !desktop.openingSession}
            {#each Object.entries(desktop.statuses).filter(([, value]) => value) as [key, value] (key)}<div
                class="extension-status"
              >
                {value}
              </div>{/each}
            {#each Object.entries(desktop.widgets).filter(([, value]) => value.length) as [key, value] (key)}
              {#if key === 'plan-todos'}
                {#key `${desktop.runtimeId}:${desktop.snapshot.sessionFile ?? ''}`}
                  <PlanTodos
                    lines={value}
                    running={desktop.run !== 'idle'}
                    disabled={desktop.connection !== 'ready' ||
                      desktop.restoring ||
                      desktop.submitting}
                    oncontinue={desktop.commands.some(
                      (command) => command.name === 'todos',
                    )
                      ? () => desktop.planAction('continue')
                      : undefined}
                    onstop={desktop.commands.some(
                      (command) => command.name === 'todos',
                    )
                      ? () =>
                          desktop.run !== 'idle'
                            ? desktop.stop()
                            : desktop.planAction('stop')
                      : undefined}
                  />
                {/key}
              {:else}<details class="widget">
                  <summary>{key}</summary>
                  <pre>{value.join('\n')}</pre>
                </details>{/if}
            {/each}
          {/if}
          {#if desktop.task?.state === 'queued'}<div
              class="queue-hint"
              role="status"
            >
              排队中，第 {desktop.task.position || '…'} 位；其他项目的任务仍在执行。
              <button
                onclick={() => desktop.guard(() => workspace.cancel(desktop))}
                >取消排队</button
              >
            </div>{/if}
          {#if workspace.sessions.filter((item) => item.project === desktop.project && item.task?.state === 'running').length > 1}
            <div class="queue-hint">
              此项目的多个会话正在执行，它们共享文件修改。
            </div>
          {/if}
          {#if desktop.queued.length}<div class="queue-hint">
              已排队 {desktop.queued.length} 条消息
            </div>{/if}
          {#if desktop.recovered.length}<div class="recovered-drafts">
              <span>可恢复草稿</span
              >{#each desktop.recovered as text, index}<button
                  title={text}
                  onclick={() => {
                    if (desktop.draft) desktop.recovered.push(desktop.draft);
                    desktop.draft = text;
                    desktop.recovered.splice(index, 1);
                  }}>草稿 {index + 1}</button
                >{/each}
            </div>{/if}
          {#if desktop.newChatProject !== null || empty}
            <ProjectPicker
              projects={workspace.projects}
              project={displayProject}
              disabled={!!desktop.openingSession ||
                desktop.connection === 'starting'}
              onselect={selectNewProject}
              oncreate={() => {
                void createNewProject();
              }}
            />
          {/if}
          {#key desktop}<CommandComposer
              {desktop}
              onsend={(mode) => {
                void desktop.guard(async () => {
                  await desktop.send(mode);
                });
              }}
            />{/key}
          <div class="composer-footnote">
            <p class="composer-note">
              Pi 在本地项目中工作，请检查重要改动。{#if desktop.version}<span
                  >Pi {desktop.version}</span
                >{/if}
            </p>
            <!-- 上下文使用率固定在右下角，与终端 footer 的位置与读数保持一致。 -->
            <ContextUsage {desktop} />
          </div>
        </div>
      </div>
    </div>
  </main>
</div>
{#if desktop.builtinRequest}
  {#if desktop.builtinRequest.name !== 'settings'}
    {#key desktop.builtinRequest}
      <BuiltinCommandDialog
        {desktop}
        name={desktop.builtinRequest.name}
        args={desktop.builtinRequest.args}
        onclose={() => {
          desktop.builtinRequest = null;
        }}
      />
    {/key}
  {/if}
{/if}
{#if renameOpen}<Modal
    title="重命名会话"
    onclose={() => {
      renameOpen = false;
    }}
    ><label class="dialog-field"
      >会话名称<input bind:value={renameValue} maxlength="200" /></label
    >
    <footer class="modal-actions">
      <button
        onclick={() => {
          renameOpen = false;
        }}>取消</button
      ><button
        class="primary"
        onclick={() => {
          void desktop.guard(async () => {
            await desktop.rename(renameValue);
            renameOpen = false;
          });
        }}>保存</button
      >
    </footer></Modal
  >{/if}
{#if desktop.pendingSwitch}<Modal
    title={desktop.pendingSwitch.waiting
      ? '等待任务完成'
      : desktop.pendingSwitch.label}
    onclose={() => {
      desktop.pendingSwitch = null;
    }}
    ><p class="dialog-message">
      {desktop.pendingSwitch.waiting
        ? '当前任务完成后会自动切换。你可以取消等待。'
        : '当前任务仍在运行。请选择如何处理后再切换。'}
    </p>
    <footer class="modal-actions">
      <button
        onclick={() => {
          desktop.pendingSwitch = null;
        }}>取消</button
      >{#if !desktop.pendingSwitch.waiting}<button
          onclick={() => desktop.waitToSwitch()}>等待完成后切换</button
        ><button
          class="primary"
          onclick={() => {
            void desktop.guard(() => desktop.stopAndSwitch());
          }}>停止并切换</button
        >{/if}
    </footer></Modal
  >{/if}
{#if full}<Modal
    title="完整正文 · 分块查看"
    wide
    onclose={() => {
      full = null;
    }}
    ><pre class="full-content">{full.text}</pre>
    <footer class="modal-actions">
      <span class="muted">已读取 {Math.ceil(full.next / 1024)} KiB</span><button
        onclick={() => {
          if (full) void showFull(full.message);
        }}>回到开头</button
      ><button
        class="primary"
        disabled={full.done || contentLoading}
        onclick={nextContent}>{full.done ? '已到末尾' : '下一块'}</button
      >
    </footer></Modal
  >{/if}
