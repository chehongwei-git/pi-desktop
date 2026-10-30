<!-- 主工作区：可排序项目侧栏、会话、输入与状态；业务副作用经过 Desktop 门面。 -->
<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { open } from '@tauri-apps/plugin-dialog';
  import { getCurrentWebview } from '@tauri-apps/api/webview';
  import { isTauri } from '@tauri-apps/api/core';
  import { Desktop } from './lib/state/desktop.svelte';
  import { errorMessage } from './lib/client';
  import type { Message, SessionSummary } from './lib/types';
  import ProjectPicker from './lib/components/ProjectPicker.svelte';
  import CommandComposer from './lib/components/CommandComposer.svelte';
  import Icon from './lib/components/Icon.svelte';
  import Transcript from './lib/components/Transcript.svelte';
  import Modal from './lib/components/Modal.svelte';
  import SettingsDialog from './lib/components/SettingsDialog.svelte';
  import ExtensionDialog from './lib/components/ExtensionDialog.svelte';
  import BuiltinCommandDialog from './lib/components/BuiltinCommandDialog.svelte';
  import SidebarSession from './lib/components/SidebarSession.svelte';
  const desktop = new Desktop();
  let newChatMode = $state(false);
  let projectSelection = $state<string | null>(null);
  let sidebar = $state(true);
  let settingsOpen = $state(false);
  let search = $state('');
  let pinnedOpen = $state(true);
  let projectsOpen = $state(true);
  let recentOpen = $state(true);
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
      void desktop.guard(() => desktop.moveProject(source, target, after));
  }
  function projectReorderKey(event: KeyboardEvent, path: string): void {
    if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const order = desktop.projects;
    const index = order.findIndex(
      (project) =>
        desktop.projectKey(project.path) === desktop.projectKey(path),
    );
    const after = event.key === 'ArrowDown';
    const target = order[index + (after ? 1 : -1)];
    if (target) {
      const button = event.currentTarget as HTMLButtonElement;
      void desktop.guard(async () => {
        await desktop.moveProject(path, target.path, after);
        await tick();
        button.focus({ preventScroll: true });
      });
    }
  }
  let searching = $derived(!!search.trim());
  function matchesSession(session: SessionSummary): boolean {
    return `${session.name} ${session.preview}`
      .toLowerCase()
      .includes(search.trim().toLowerCase());
  }
  let pinnedSessions = $derived(desktop.pinnedSessions.filter(matchesSession));
  let recentSessions = $derived(desktop.recentSessions.filter(matchesSession));
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
    return desktop.projects
      .map((project) => ({
        ...project,
        sessions: query
          ? project.sessions.filter((session) =>
              `${session.name} ${session.preview}`
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
    !desktop.openingSession && desktop.messages.length === 0,
  );
  let modelKey = $derived(
    desktop.snapshot.model
      ? `${desktop.snapshot.model.provider}/${desktop.snapshot.model.id}`
      : '',
  );
  let runLabel = $derived(
    {
      idle: '',
      running: 'Pi 正在处理',
      retrying: '正在重试',
      compacting: '正在压缩上下文',
      aborting: '正在停止任务',
    }[desktop.run],
  );
  onMount(() => {
    void desktop.init();
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    themeDark = media.matches;
    const change = () => {
      themeDark = media.matches;
    };
    media.addEventListener('change', change);
    return () => {
      media.removeEventListener('change', change);
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
    desktop.requestSwitch('开始新对话', async () => {
      await desktop.newSession(project);
      if (desktop.connection === 'ready') {
        newChatMode = true;
        projectSelection = project;
      }
    });
  }
  function selectNewProject(project: string): void {
    desktop.requestSwitch('选择新对话项目', async () => {
      const draft = desktop.draft;
      await desktop.newSession(project);
      if (desktop.connection === 'ready') {
        projectSelection = project;
        desktop.draft = draft;
        newChatMode = true;
      }
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
  function selectSession(project: string, path: string): void {
    desktop.requestSwitch('打开历史会话', async () => {
      await desktop.openSession(project, path);
      newChatMode = false;
      projectSelection = null;
      sidebar = window.innerWidth > 900;
    });
  }
  /** 快捷键与普通输入不冲突；原生 dialog 已处理 Escape/焦点约束。 */
  function keydown(event: KeyboardEvent): void {
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
      if (key === 'b') sidebar = !sidebar;
      if (key === ',') settingsOpen = true;
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
{#snippet sessionItem(session: SessionSummary, showProject = false)}
  <SidebarSession
    {session}
    {showProject}
    active={session.path === desktop.snapshot.sessionFile}
    pinned={desktop.isPinned(session.path)}
    busy={desktop.pinSaving}
    disabled={!!desktop.openingSession}
    onopen={() => selectSession(session.cwd, session.path)}
    onpin={() => {
      void desktop.guard(() => desktop.togglePin(session.path));
    }}
  />
{/snippet}
<div class="app-shell" class:sidebar-hidden={!sidebar}>
  {#if sidebar}<button
      class="sidebar-backdrop"
      aria-label="收起侧栏"
      onclick={() => {
        sidebar = false;
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
          sidebar = false;
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
        placeholder="搜索会话"
        aria-label="搜索历史会话"
      />
    </div>
    <nav
      class="history-list"
      aria-label="项目与历史会话"
      aria-busy={desktop.loadingSessions}
    >
      <section class="sidebar-section" aria-label="置顶">
        <div class="section-label">
          <button
            class="section-toggle"
            aria-expanded={pinnedOpen || searching}
            onclick={() => {
              pinnedOpen = !pinnedOpen;
            }}
          >
            <span
              class="project-chevron"
              class:collapsed={!(pinnedOpen || searching)}
              ><Icon name="down" size={13} /></span
            >
            <span>置顶</span><small>{pinnedSessions.length}</small>
          </button>
        </div>
        {#if pinnedOpen || searching}
          {#each pinnedSessions as session (session.path)}
            {@render sessionItem(session, true)}
          {:else}<div class="history-empty">
              {searching ? '没有匹配的置顶会话' : '点击会话旁的图钉置顶'}
            </div>{/each}
        {/if}
      </section>
      <section class="sidebar-section" aria-label="工作项目">
        <div class="section-label">
          <button
            class="section-toggle"
            aria-expanded={projectsOpen || searching}
            onclick={() => {
              projectsOpen = !projectsOpen;
              showAllProjects = false;
            }}
          >
            <span
              class="project-chevron"
              class:collapsed={!(projectsOpen || searching)}
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
        {#if projectsOpen || searching}
          {#each visibleProjects as project (desktop.projectKey(project.path))}
            {@const expanded = desktop.isExpanded(project.path) || searching}
            <div class="project-group">
              <div class="project-row">
                <button
                  class="project-current"
                  class:active={desktop.projectKey(project.path) ===
                    desktop.projectKey(desktop.project)}
                  class:project-dragging={draggingProject === project.path}
                  class:drop-before={dropProject === project.path && !dropAfter}
                  class:drop-after={dropProject === project.path && dropAfter}
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
                    if (!draggingProject || desktop.projectOrderSaving) return;
                    event.preventDefault();
                    if (event.dataTransfer)
                      event.dataTransfer.dropEffect = 'move';
                    const bounds = event.currentTarget.getBoundingClientRect();
                    dropProject = project.path;
                    dropAfter = event.clientY > bounds.top + bounds.height / 2;
                  }}
                  ondragleave={() => {
                    if (dropProject === project.path) dropProject = '';
                  }}
                  ondrop={(event) => projectDrop(event, project.path)}
                  onkeydown={(event) => projectReorderKey(event, project.path)}
                  aria-expanded={expanded}
                  onclick={() => desktop.toggleProject(project.path)}
                >
                  <span class="project-chevron" class:collapsed={!expanded}
                    ><Icon name="down" size={13} /></span
                  >
                  <Icon name="folder" size={17} /><span class="project-name"
                    >{project.path.split(/[\\/]/).filter(Boolean).pop() ||
                      project.path}</span
                  >
                  <small>{project.sessions.length}</small>
                </button>
                <button
                  class="icon-button project-new"
                  aria-label={`在 ${project.path} 中新建会话`}
                  onclick={() => newChat(project.path)}
                  ><Icon name="plus" size={15} /></button
                >
              </div>
              {#if expanded}
                <div class="project-sessions">
                  {#each project.sessions as session (session.path)}
                    {@render sessionItem(session)}
                  {:else}<div class="history-empty">
                      暂无会话，点击 + 开始对话
                    </div>{/each}
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
      <section class="sidebar-section" aria-label="最近">
        <div class="section-label">
          <button
            class="section-toggle"
            aria-expanded={recentOpen || searching}
            onclick={() => {
              recentOpen = !recentOpen;
            }}
          >
            <span
              class="project-chevron"
              class:collapsed={!(recentOpen || searching)}
              ><Icon name="down" size={13} /></span
            >
            <span>最近</span><small>{recentSessions.length}</small>
          </button>
        </div>
        {#if recentOpen || searching}
          {#each recentSessions as session (session.path)}
            {@render sessionItem(session, true)}
          {:else}<div class="history-empty">
              {searching ? '没有匹配的会话' : '暂无最近会话'}
            </div>{/each}
        {/if}
      </section>
    </nav>
    <button
      class="sidebar-settings"
      onclick={() => {
        settingsOpen = true;
      }}
      ><Icon name="settings" size={19} /><span>设置</span><small
        >本地 Pi · RPC</small
      ></button
    >
  </aside>
  <main class="main-pane">
    <header class="topbar">
      <div class="topbar-left">
        {#if !sidebar}<button
            class="icon-button"
            aria-label="展开侧栏"
            onclick={() => {
              sidebar = true;
            }}><Icon name="panel" /></button
          >{/if}<span class="product-name">Pi</span><select
          class="model-select"
          aria-label="模型"
          value={modelKey}
          disabled={!!desktop.openingSession ||
            desktop.connection !== 'ready' ||
            desktop.run !== 'idle'}
          onchange={(event) => {
            void desktop.guard(() =>
              desktop.setModel(event.currentTarget.value),
            );
          }}
          ><option value=""
            >{desktop.connection === 'starting'
              ? '正在连接…'
              : '选择模型'}</option
          >{#each desktop.models as model}<option
              value={`${model.provider}/${model.id}`}
              >{model.name} · {model.provider}</option
            >{/each}</select
        >{#if desktop.levels.length > 1}<select
            class="thinking-select"
            aria-label="思考级别"
            value={desktop.snapshot.thinkingLevel ?? 'off'}
            disabled={!!desktop.openingSession || desktop.run !== 'idle'}
            onchange={(event) => {
              const level = event.currentTarget.value;
              void desktop.guard(async () => {
                await desktop.action({ type: 'set_thinking', level });
                await desktop.syncState();
              });
            }}
            >{#each desktop.levels as level}<option value={level}
                >{level}</option
              >{/each}</select
          >{/if}
      </div>
      <div class="topbar-right">
        <span
          class="connection"
          class:connected={desktop.connection === 'ready'}
          ><span class="status-dot"></span>{desktop.connection === 'ready'
            ? '已连接'
            : desktop.connection === 'starting'
              ? '连接中'
              : desktop.connection === 'failed'
                ? '连接失败'
                : '未连接'}</span
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
                disabled={!!desktop.openingSession ||
                  !desktop.snapshot.sessionFile}
                onclick={() => {
                  void desktop.guard(copyPath);
                }}>复制会话路径</button
              ><button
                disabled={!!desktop.openingSession ||
                  desktop.run !== 'idle' ||
                  !desktop.snapshot.sessionFile}
                onclick={() => {
                  renameValue = desktop.snapshot.sessionName ?? '';
                  renameOpen = true;
                  sessionMenu = false;
                }}>重命名当前会话</button
              ><button
                disabled={!!desktop.openingSession ||
                  desktop.connection === 'disconnected'}
                onclick={() => {
                  sessionMenu = false;
                  void desktop.guard(() => desktop.disconnect());
                }}>断开 Pi</button
              >
            </div>{/if}
        </div>
      </div>
    </header>
    {#if desktop.project || desktop.openingSession}
      <div class="conversation-heading">
        <h1 class="session-title" title={desktop.sessionTitle}>
          {desktop.sessionTitle}
        </h1>
      </div>
    {/if}
    {#if desktop.error}<div class="banner error-banner" role="alert">
        <span>{desktop.error}</span><button
          class="text-button"
          onclick={() => {
            settingsOpen = true;
          }}>设置</button
        >{#if desktop.project}<button
            class="text-button"
            onclick={() =>
              desktop.requestSwitch('重新连接', () =>
                desktop.connect(desktop.project),
              )}>重新连接</button
          >{/if}<button
          class="icon-button"
          aria-label="关闭错误"
          onclick={() => {
            desktop.error = '';
          }}><Icon name="close" size={15} /></button
        >
      </div>{/if}
    {#if desktop.notice}<div class="banner notice-banner" role="status">
        <span>{desktop.notice}</span>{#if desktop.run === 'aborting'}<button
            class="text-button"
            onclick={() => {
              void desktop.guard(() => desktop.disconnect(true));
            }}>强制关闭</button
          >{/if}<button
          class="icon-button"
          aria-label="关闭提示"
          onclick={() => {
            desktop.notice = '';
          }}><Icon name="close" size={15} /></button
        >
      </div>{/if}
    <div class="conversation" class:empty aria-busy={!!desktop.openingSession}>
      {#if desktop.openingSession}
        <div class="session-loading" role="status" aria-label="正在加载会话">
          <span class="loading-indicator" aria-hidden="true"
            ><Icon name="refresh" size={20} /></span
          >
        </div>
      {:else if empty}<div class="welcome">
          <div class="welcome-logo"><Icon name="pi" size={40} /></div>
          <h1>
            {desktop.project ? '今天想做些什么？' : '让 Pi 与你的项目一起工作'}
          </h1>
          <p>
            {desktop.project
              ? desktop.project
              : '直接新建对话，或选择项目文件夹开始。'}
          </p>
          {#if !desktop.project}<button
              class="choose-project"
              onclick={chooseProject}
              ><Icon name="folder" size={18} />选择项目文件夹</button
            >{:else if desktop.connection === 'disconnected' || desktop.connection === 'failed'}<button
              class="choose-project"
              onclick={() => {
                void desktop.connect(desktop.project);
              }}>连接 Pi</button
            >{/if}
        </div>
      {:else}{#key `${desktop.runtimeId}:${desktop.snapshot.sessionFile ?? ''}`}<Transcript
            messages={desktop.messages}
            hasMore={desktop.hasMore}
            loading={desktop.loadingHistory}
            onolder={() => desktop.refreshHistory(desktop.before)}
            onfull={(message) => {
              void showFull(message);
            }}
            toolViews={desktop.toolViews}
            ontoggletool={(id, section) => desktop.toggleTool(id, section)}
            read={(id, offset) => desktop.readContent(id, offset)}
            onvisible={(ids) => desktop.pinVisible(ids)}
            onload={(message) => desktop.loadPreview(message)}
            onerror={(message) => {
              desktop.error = message;
            }}
          />{/key}{/if}
      <div class="composer-area">
        {#if runLabel}<div class="run-status" role="status">
            <span class="working status-dot"></span>{runLabel}
          </div>{/if}
        {#each Object.entries(desktop.statuses).filter(([, value]) => value) as [key, value] (key)}<div
            class="extension-status"
          >
            {value}
          </div>{/each}
        {#each Object.entries(desktop.widgets).filter(([, value]) => value.length) as [key, value] (key)}<details
            class="widget"
          >
            <summary>{key}</summary>
            <pre>{value.join('\n')}</pre>
          </details>{/each}
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
        {#if newChatMode || empty}
          <ProjectPicker
            projects={desktop.projects}
            project={projectSelection ?? desktop.project}
            disabled={!!desktop.openingSession ||
              desktop.connection === 'starting'}
            onselect={selectNewProject}
            oncreate={() => {
              void createNewProject();
            }}
          />
        {/if}
        <CommandComposer
          {desktop}
          onsend={(mode) => {
            void desktop.guard(async () => {
              await desktop.send(mode);
              if (!desktop.draft.trim()) newChatMode = false;
            });
          }}
        />
        <p class="composer-footnote">
          Pi 在本地项目中工作，请检查重要改动。{#if desktop.version}<span
              >Pi {desktop.version}</span
            >{/if}
        </p>
      </div>
    </div>
  </main>
</div>
{#if settingsOpen}<SettingsDialog
    {desktop}
    onclose={() => {
      settingsOpen = false;
    }}
  />{/if}
{#if desktop.builtinRequest}
  {#if desktop.builtinRequest.name === 'settings'}
    <SettingsDialog
      {desktop}
      onclose={() => {
        desktop.builtinRequest = null;
      }}
    />
  {:else}
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
{#if desktop.extensions[0]}{#key desktop.extensions[0].id}<ExtensionDialog
      request={desktop.extensions[0]}
      onrespond={(value) => {
        const request = desktop.extensions[0];
        void desktop.guard(() => desktop.respond(request, value));
      }}
    />{/key}{/if}
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
