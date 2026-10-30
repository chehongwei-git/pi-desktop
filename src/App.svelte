<!-- ChatGPT 风格主工作区：侧栏/欢迎页/底部输入/状态，所有业务副作用经过 Desktop 门面。 -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { open } from '@tauri-apps/plugin-dialog';
  import { Desktop } from './lib/state/desktop.svelte';
  import { dateGroup } from './lib/state/reducer';
  import { errorMessage } from './lib/client';
  import type { Message } from './lib/types';
  import Composer from './lib/components/Composer.svelte';
  import Icon from './lib/components/Icon.svelte';
  import Transcript from './lib/components/Transcript.svelte';
  import Modal from './lib/components/Modal.svelte';
  import SettingsDialog from './lib/components/SettingsDialog.svelte';
  import ExtensionDialog from './lib/components/ExtensionDialog.svelte';
  const desktop = new Desktop();
  let sidebar = $state(true);
  let settingsOpen = $state(false);
  let search = $state('');
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
  let searchTimer: ReturnType<typeof setTimeout>;
  let lastFocus = 0;
  let empty = $derived(desktop.messages.length === 0);
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
      clearTimeout(searchTimer);
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
  /** 搜索只查摘要；150ms 防抖，门面另用代数抑制过期响应。 */
  $effect(() => {
    const query = search;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      void desktop.guard(() => desktop.refreshSessions(query));
    }, 150);
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
  /** 新对话保留项目；未连接时先连接，不发起无效 RPC。 */
  function newChat(): void {
    desktop.requestSwitch('开始新对话', async () => {
      if (!desktop.project) return;
      if (desktop.connection !== 'ready')
        await desktop.connect(desktop.project);
      else await desktop.switchSession();
    });
  }
  /** 恢复历史时先建立该项目连接；被扩展取消时门面保持原状态。 */
  function selectSession(path: string): void {
    desktop.requestSwitch('打开历史会话', async () => {
      if (desktop.connection !== 'ready')
        await desktop.connect(desktop.project);
      await desktop.switchSession(path);
      sidebar = window.innerWidth > 900;
    });
  }
  /** 快捷键与普通输入不冲突；原生 dialog 已处理 Escape/焦点约束。 */
  function keydown(event: KeyboardEvent): void {
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
    void desktop.guard(() => desktop.refreshSessions(search));
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
    <button class="nav-new" onclick={newChat}
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
    <div class="project-section">
      <div class="section-label">
        工作项目<button
          class="icon-button"
          aria-label="选择项目文件夹"
          onclick={chooseProject}><Icon name="plus" size={15} /></button
        >
      </div>
      <button
        class="project-current"
        title={desktop.project || '选择本地项目'}
        onclick={chooseProject}
        ><Icon name="folder" size={17} /><span
          >{desktop.project.split(/[\\/]/).filter(Boolean).pop() ||
            '选择项目文件夹'}</span
        ><Icon name="down" size={13} /></button
      >
      {#if desktop.settings.recentProjects.length}<select
          class="recent-select"
          aria-label="最近项目"
          value={desktop.project}
          onchange={(event) => {
            const project = event.currentTarget.value;
            if (project)
              desktop.requestSwitch('切换项目', () => desktop.connect(project));
          }}
          ><option value="">最近项目</option
          >{#each desktop.settings.recentProjects as project}<option
              value={project}>{project}</option
            >{/each}</select
        >{/if}
    </div>
    <nav class="history-list" aria-label="历史会话">
      {#each desktop.sessions as session, index (session.path)}
        {#if index === 0 || dateGroup(session.modified) !== dateGroup(desktop.sessions[index - 1].modified)}<h3
          >
            {dateGroup(session.modified)}
          </h3>{/if}
        <button
          class="history-item"
          class:active={session.path === desktop.snapshot.sessionFile}
          title={session.warning ?? session.name ?? session.preview}
          onclick={() => selectSession(session.path)}
          ><span>{session.name || session.preview || session.timestamp}</span
          >{#if session.warning}<span title={session.warning}>!</span
            >{/if}</button
        >
      {:else}<div class="history-empty">
          {search
            ? '没有匹配的会话'
            : desktop.project
              ? '在这里继续你的对话'
              : '选择项目后显示历史会话'}
        </div>{/each}
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
          disabled={desktop.connection !== 'ready' || desktop.run !== 'idle'}
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
            disabled={desktop.run !== 'idle'}
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
                disabled={!desktop.snapshot.sessionFile}
                onclick={() => {
                  void desktop.guard(copyPath);
                }}>复制会话路径</button
              ><button
                disabled={desktop.run !== 'idle' ||
                  !desktop.snapshot.sessionFile}
                onclick={() => {
                  renameValue = desktop.snapshot.sessionName ?? '';
                  renameOpen = true;
                  sessionMenu = false;
                }}>重命名当前会话</button
              ><button
                disabled={desktop.connection === 'disconnected'}
                onclick={() => {
                  sessionMenu = false;
                  void desktop.guard(() => desktop.disconnect());
                }}>断开 Pi</button
              >
            </div>{/if}
        </div>
      </div>
    </header>
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
    <div class="conversation" class:empty>
      {#if empty}<div class="welcome">
          <div class="welcome-logo"><Icon name="pi" size={40} /></div>
          <h1>
            {desktop.project ? '今天想做些什么？' : '让 Pi 与你的项目一起工作'}
          </h1>
          <p>
            {desktop.project
              ? desktop.project
              : '选择一个本地项目，开始对话、阅读代码与完成任务。'}
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
      {:else}<Transcript
          messages={desktop.messages}
          hasMore={desktop.hasMore}
          loading={desktop.loadingHistory}
          onolder={() => desktop.refreshHistory(desktop.before)}
          onfull={(message) => {
            void showFull(message);
          }}
          onvisible={(ids) => desktop.pinVisible(ids)}
          onload={(message) => desktop.loadPreview(message)}
          onerror={(message) => {
            desktop.error = message;
          }}
        />{/if}
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
        <Composer
          bind:value={desktop.draft}
          disabled={desktop.connection !== 'ready'}
          running={desktop.run !== 'idle'}
          submitting={desktop.submitting}
          commands={desktop.commands}
          onsend={(mode) => {
            void desktop.guard(() => desktop.send(mode));
          }}
          onstop={() => {
            void desktop.guard(() => desktop.stop());
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
