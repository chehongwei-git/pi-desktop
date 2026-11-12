<!-- 插件中心保留页面草稿；配置与运行状态分离，不因进入页面启动会话。 -->
<script lang="ts">
  import { onMount, tick } from 'svelte';
  import Icon from './Icon.svelte';
  import SettingsSelect from './SettingsSelect.svelte';
  import PluginDetail from './PluginDetail.svelte';
  import PluginOnlineInstall from './PluginOnlineInstall.svelte';
  import { errorMessage } from '../client';
  import {
    pluginBridge,
    pluginTabs,
    type Plugin,
    type PluginCatalog,
    type PluginChange,
  } from '../plugins';
  type Session = {
    runtimeId: string;
    project: string;
    connection: string;
    run: string;
    sessionTitle: string;
    action: <T = unknown>(action: { type: 'reload' }) => Promise<T>;
    syncState: () => Promise<void>;
    refreshMetadata: () => Promise<void>;
  };
  let {
    projects,
    sessions,
    onclose,
    api = pluginBridge,
  }: {
    projects: { path: string; name?: string }[];
    sessions: Session[];
    onclose: () => void;
    api?: typeof pluginBridge;
  } = $props();
  let tab = $state<'mcp' | 'skills' | 'extensions'>('mcp');
  let project = $state('');
  let search = $state('');
  let catalog = $state<PluginCatalog | null>(null);
  let busy = $state(false);
  let error = $state('');
  let status = $state('');
  let selected = $state<Plugin | null>(null);
  let detail = $state('');
  let detailLoading = $state(false);
  let adding = $state(false);
  let online = $state(false);
  let onlineDirty = $state(false);
  let onlineTrigger: HTMLElement | null = null;
  let onlinePosition = 0;
  let mode = $state('http');
  let name = $state('');
  let source = $state('');
  let args = $state('');
  let preview = $state(false);
  let confirm = $state<Plugin | null>(null);
  let pendingLeave = $state<(() => void) | null>(null);
  let pending = $state<string[]>([]);
  let heading: HTMLHeadingElement;
  let scroller: HTMLDivElement;
  let listPosition = 0;
  /** 切换编辑/预览时只重置管理页滚动，不影响后台对话阅读位置。 */
  async function showTop() {
    await tick();
    if (scroller) scroller.scrollTop = 0;
  }
  function setPreview(value: boolean) {
    preview = value;
    void showTop();
  }
  let origin: HTMLElement | null = null;
  let generation = 0;
  const current = $derived(pluginTabs.find((t) => t.id === tab)!);
  const scopeLabel = $derived(
    project
      ? projects.find((p) => p.path === project)?.name || project
      : '全局',
  );
  const modeOptions = $derived(
    tab === 'mcp'
      ? [
          {
            value: 'http',
            label: '远程 HTTP',
            description: '通过服务地址连接外部工具',
          },
          {
            value: 'stdio',
            label: '本地进程',
            description: '使用程序与独立参数启动',
          },
          {
            value: 'json',
            label: 'JSON 配置',
            description: '粘贴单个服务器配置对象',
          },
        ]
      : [
          {
            value: 'local',
            label: tab === 'skills' ? '本地 Skill 目录' : '本地扩展',
            description: '引用本机已有文件，不复制源码',
          },
          {
            value: 'package',
            label: 'Pi 安装包',
            description: '从 npm、Git 或本地来源安装',
          },
        ],
  );
  // 每种接入方式独立保存输入，切换时不会误将 URL 当成程序或覆盖用户工作。
  const modeDrafts = new Map<string, { source: string; args: string }>();
  function selectMode(value: string | null) {
    modeDrafts.set(mode, { source, args });
    mode = value ?? 'http';
    const draft = modeDrafts.get(mode);
    source = draft?.source ?? '';
    args = draft?.args ?? '';
    clearFeedback();
  }
  const dirty = $derived((adding && !!(name || source || args)) || onlineDirty);
  const rows = $derived(
    (catalog?.items ?? []).filter(
      (p) =>
        (p.kind === tab || (tab === 'extensions' && p.kind === 'packages')) &&
        `${p.name} ${p.description} ${p.source}`
          .toLowerCase()
          .includes(search.trim().toLowerCase()),
    ),
  );
  const groups = $derived(
    tab === 'extensions'
      ? [
          {
            label: '用户扩展',
            items: rows.filter(
              (p) => p.kind !== 'packages' && !p.id.startsWith('builtin:'),
            ),
          },
          {
            label: '内置扩展',
            items: rows.filter((p) => p.id.startsWith('builtin:')),
          },
          { label: '安装包', items: rows.filter((p) => p.kind === 'packages') },
        ].filter((g) => g.items.length)
      : [{ label: '', items: rows }],
  );
  const affected = $derived(
    sessions.filter(
      (s) =>
        s.runtimeId &&
        s.connection === 'ready' &&
        (!project || s.project === project),
    ),
  );
  onMount(() => {
    heading?.focus({ preventScroll: true });
    void load();
  });
  /** 所有导航共用就地保护；操作执行中不卸载页面，避免丢失结果。 */
  export function requestLeave(action: () => void = onclose): void {
    if (busy || dirty) {
      pendingLeave = action;
      return;
    }
    action();
  }
  /** 操作反馈只属于当前内容；确认导航后清理，取消离开时保留错误与草稿。 */
  function clearFeedback() {
    error = '';
    status = '';
  }
  async function load() {
    const token = ++generation;
    busy = true;
    clearFeedback();
    try {
      const result = await api.catalog(project || null);
      if (token === generation) catalog = result;
    } catch (e) {
      if (token === generation) error = errorMessage(e);
    } finally {
      if (token === generation) busy = false;
    }
  }
  function reset() {
    // 导航后丢弃未完成的旧详情响应，防止错误或焦点回写到新的分类。
    ++generation;
    detailLoading = false;
    detail = '';
    modeDrafts.clear();
    adding = false;
    online = false;
    onlineDirty = false;
    preview = false;
    name = '';
    source = '';
    args = '';
    selected = null;
    confirm = null;
  }
  function navigate(action: () => void) {
    requestLeave(() => {
      reset();
      clearFeedback();
      action();
      void showTop();
    });
  }
  function saved() {
    // 待应用按具体租约记录，不把磁盘保存误报为运行成功；未连接会话由下次连接加载。
    pending = [...new Set([...pending, ...affected.map((s) => s.runtimeId)])];
    status = affected.length
      ? '已保存。已有会话尚未应用，请在空闲时重新加载。'
      : '已保存，下次连接 Pi 时读取；项目信任仍由 Pi 决定。';
  }
  async function change(change: Omit<PluginChange, 'revision'>) {
    if (!catalog || busy) return;
    busy = true;
    error = '';
    try {
      catalog = await api.change(project || null, {
        ...change,
        revision: catalog.revision,
      });
      saved();
      reset();
    } catch (e) {
      error = errorMessage(e);
    } finally {
      busy = false;
    }
  }
  async function inspect(item: Plugin, trigger: HTMLElement) {
    origin = trigger;
    listPosition = scroller?.scrollTop ?? 0;
    selected = item;
    clearFeedback();
    void showTop();
    detail = '';
    detailLoading = true;
    const token = ++generation;
    try {
      const value = await api.detail(project || null, item);
      if (token === generation) detail = value;
    } catch (e) {
      if (token === generation) error = errorMessage(e);
    } finally {
      if (token === generation) detailLoading = false;
    }
    await tick();
    if (token === generation) heading?.focus({ preventScroll: true });
  }
  async function back() {
    ++generation;
    selected = null;
    detailLoading = false;
    detail = '';
    clearFeedback();
    await tick();
    if (scroller) scroller.scrollTop = listPosition;
    if (origin?.isConnected) origin.focus({ preventScroll: true });
    else heading?.focus({ preventScroll: true });
  }
  async function command(action: string, value = source.trim()) {
    if (busy) return;
    busy = true;
    error = '';
    status = '正在执行 Pi 操作，请勿重复提交…';
    try {
      const result = await api.command(project || null, action, value);
      status = result.message;
      if (['install', 'update'].includes(action)) {
        catalog = await api.catalog(project || null);
        saved();
        reset();
      }
    } catch (e) {
      error = errorMessage(e);
      status = '操作未确认成功。请重新读取配置后核对，不会自动重试。';
    } finally {
      busy = false;
    }
  }
  async function apply(session: Session) {
    if (busy || session.run !== 'idle') return;
    busy = true;
    error = '';
    const runtime = session.runtimeId;
    try {
      await session.action({ type: 'reload' });
      if (runtime !== session.runtimeId)
        throw new Error('会话连接已变化，请重新检查加载状态。');
      await session.syncState();
      await session.refreshMetadata();
      pending = pending.filter((id) => id !== runtime);
      status =
        '会话已重新加载。资源是否成功加载请结合 Pi 的错误提示与实际命令检查。';
    } catch (e) {
      error = `配置仍已保存，重新加载失败：${errorMessage(e)}`;
    } finally {
      busy = false;
    }
  }
  /** 全局安装影响所有已连接会话；列表刷新失败不重放安装命令。 */
  function installedOnline(globalCatalog: PluginCatalog) {
    if (!project) catalog = globalCatalog;
    else {
      const scope = project;
      const token = generation;
      void api
        .catalog(scope)
        .then((value) => {
          if (scope === project && token === generation) catalog = value;
        })
        .catch(() => {
          if (scope === project && token === generation)
            status = '已全局安装，项目列表刷新失败，请重新读取插件。';
        });
    }
    pending = [
      ...new Set([
        ...pending,
        ...sessions
          .filter((s) => s.runtimeId && s.connection === 'ready')
          .map((s) => s.runtimeId),
      ]),
    ];
  }
  function leaveOnline() {
    requestLeave(() => {
      reset();
      clearFeedback();
      void tick().then(() => {
        if (scroller) scroller.scrollTop = onlinePosition;
        onlineTrigger?.focus({ preventScroll: true });
      });
    });
  }
  function viewInstalled() {
    reset();
    project = '';
    tab = 'extensions';
    search = '';
    void load();
    void showTop();
    void tick().then(() => heading?.focus({ preventScroll: true }));
  }
  function add() {
    if (mode === 'package') {
      void command('install');
      return;
    }
    let config: Record<string, unknown> | undefined;
    let id = source.trim();
    if (tab === 'mcp') {
      id = name.trim();
      try {
        config =
          mode === 'json'
            ? JSON.parse(source)
            : mode === 'http'
              ? { url: source.trim() }
              : {
                  command: source.trim(),
                  args: args.split('\n').filter(Boolean),
                };
      } catch {
        error = 'JSON 配置无效，输入已保留。';
        return;
      }
    }
    void change({ kind: tab, id, action: 'add', config });
  }
</script>

<section class="plugins-page" aria-label="插件管理">
  <header>
    <div>
      <p class="eyebrow">本地工作空间</p>
      <h1 bind:this={heading} tabindex="-1">插件</h1>
      <p>为 Pi 连接工具、装配技能与扩展。</p>
    </div>
    <div class="header-actions">
      <button
        disabled={busy}
        onclick={(event) => {
          onlineTrigger = event.currentTarget;
          onlinePosition = scroller?.scrollTop ?? 0;
          navigate(() => {
            online = true;
            status = '';
            error = '';
          });
        }}>在线安装</button
      >
      <button onclick={() => requestLeave()}>← 返回对话</button>
    </div>
  </header>
  <nav aria-label="插件分类">
    {#each pluginTabs as item}<button
        aria-current={tab === item.id ? 'page' : undefined}
        class:active={tab === item.id}
        onclick={() =>
          navigate(() => {
            tab = item.id;
            search = '';
          })}
        ><Icon name={item.icon} size={17} />{item.label}<small
          >{catalog?.items.filter(
            (p) =>
              p.kind === item.id ||
              (item.id === 'extensions' && p.kind === 'packages'),
          ).length ?? '—'}</small
        ></button
      >{/each}
  </nav>
  <div class="plugins-scroll" bind:this={scroller}>
    <div class="content">
      {#if !adding && !selected && !online}<div class="toolbar">
          <div class="scope">
            <SettingsSelect
              label="配置范围"
              accessibleLabel="插件配置范围"
              value={project}
              disabled={busy || dirty}
              searchable={projects.length > 5}
              options={[
                { value: '', label: '全局', description: '适用于所有项目' },
                ...projects.map((p) => ({
                  value: p.path,
                  label:
                    p.name ||
                    p.path.split(/[\\/]/).filter(Boolean).at(-1) ||
                    p.path,
                  description: p.path,
                })),
              ]}
              onchange={(value) => {
                reset();
                project = value ?? '';
                void load();
              }}
            />
          </div>
          <label class="search"
            ><Icon name="search" size={16} /><input
              aria-label="搜索插件"
              bind:value={search}
              placeholder={`搜索 ${current.label}…`}
            /></label
          >
          <button
            disabled={busy || dirty}
            onclick={() => {
              reset();
              void load();
            }}
            aria-label="重新读取插件"><Icon name="refresh" size={16} /></button
          >
          <button
            class="primary"
            disabled={busy}
            onclick={() =>
              navigate(() => {
                adding = true;
                mode = tab === 'mcp' ? 'http' : 'local';
              })}
            ><Icon name="plus" size={16} />{tab === 'mcp'
              ? '添加 MCP'
              : tab === 'skills'
                ? '添加 Skill'
                : '安装扩展'}</button
          >
        </div>{:else}<div class="subnav">
          <button
            class="text-button"
            disabled={busy}
            onclick={() => {
              if (online) void leaveOnline();
              else if (selected) void back();
              else navigate(() => {});
            }}>← 返回{current.label}</button
          ><span
            ><Icon name="folder" size={14} />{online
              ? '全局'
              : scopeLabel}</span
          >
        </div>{/if}
      {#if error}<div class="feedback failure" role="alert">
          <Icon name="warning" size={17} />
          <div>
            <strong>操作未完成</strong>
            <p>{error}</p>
          </div>
        </div>{/if}
      {#if status}<div class="feedback status" role="status">
          <Icon name={busy ? 'refresh' : 'info'} size={17} /><span
            >{status}</span
          >
        </div>{/if}
      {#if pendingLeave}<div class="feedback leave" role="alert">
          <strong>{busy ? '正在处理插件操作' : '有未保存的插件输入'}</strong>
          <p>
            {busy
              ? '请等待操作结束，再决定是否离开。'
              : '离开会放弃本次输入，已保存的配置不受影响。'}
          </p>
          <button
            onclick={() => {
              pendingLeave = null;
            }}>继续留在此页</button
          ><button
            disabled={busy}
            onclick={() => {
              const action = pendingLeave;
              pendingLeave = null;
              reset();
              action?.();
            }}>放弃输入并继续</button
          >
        </div>{/if}
      {#if online}
        <PluginOnlineInstall
          {api}
          projectItems={catalog?.items ?? []}
          onbusy={(value) => {
            busy = value;
          }}
          ondirty={(value) => {
            onlineDirty = value;
          }}
          oninstalled={installedOnline}
          onview={viewInstalled}
        />
      {:else if adding}
        <div class="form-card">
          <div class="form-heading">
            <span class="type-icon"><Icon name={current.icon} size={22} /></span
            >
            <div>
              <h2>{current.label} · {preview ? '确认接入' : '添加来源'}</h2>
              <p>接入你信任的工具与资源。</p>
            </div>
          </div>
          <ol class="form-steps" aria-label="接入步骤">
            <li class:current={!preview}><span>1</span>填写来源</li>
            <li class:current={preview}><span>2</span>确认接入</li>
          </ol>
          {#if preview}<dl class="preview-summary">
              <dt>名称</dt>
              <dd>{name || source.split(/[\\/]/).at(-1) || current.label}</dd>
              <dt>配置范围</dt>
              <dd>{scopeLabel}</dd>
              <dt>接入方式</dt>
              <dd>{modeOptions.find((o) => o.value === mode)?.label}</dd>
              <dt>来源</dt>
              <dd>
                {mode === 'json'
                  ? 'JSON 配置已填写（不展示可能包含的凭据）'
                  : mode === 'http'
                    ? 'HTTP 地址已填写（认证与查询参数不在预览中展示）'
                    : '来源已填写，可返回编辑核对完整输入'}
              </dd>
              <dt>生效时机</dt>
              <dd>保存后手动重载空闲会话，或下次连接时读取。</dd>
            </dl>{/if}
          <fieldset disabled={busy} hidden={preview}>
            <SettingsSelect
              label="接入方式"
              value={mode}
              options={modeOptions}
              disabled={busy}
              onchange={selectMode}
            />
            {#if tab === 'mcp'}<label
                >服务器名称<input
                  bind:value={name}
                  placeholder="例如 github"
                  autocomplete="off"
                /></label
              >{/if}
            <label
              >{mode === 'http'
                ? '服务地址'
                : mode === 'stdio'
                  ? '可执行程序（不是 Shell 命令）'
                  : mode === 'json'
                    ? '服务器配置 JSON'
                    : mode === 'package'
                      ? '安装包来源'
                      : '本地绝对路径'}{#if mode === 'json'}<textarea
                  rows="8"
                  bind:value={source}
                  spellcheck="false"
                  placeholder={'{ "url": "https://example.com/mcp" }'}
                ></textarea>{:else}<input
                  bind:value={source}
                  spellcheck="false"
                  autocomplete="off"
                  placeholder={mode === 'package'
                    ? 'npm:@example/pi-tools@1.0.0'
                    : mode === 'http'
                      ? 'https://example.com/mcp'
                      : mode === 'stdio'
                        ? '例如 node 或 uvx'
                        : '输入本地绝对路径'}
                />{/if}</label
            >
            {#if mode === 'stdio'}<label
                >程序参数（每行一个）<textarea rows="3" bind:value={args}
                ></textarea></label
              >{/if}
          </fieldset>
          {#if preview}<div class="feedback">
              <strong>请确认来源可信</strong>
              <p>
                {mode === 'package'
                  ? '安装可能执行第三方安装脚本，包可能包含扩展、Skills、主题及提示词。安装前无法保证获得完整资源清单；失败也不能保证撤销脚本副作用。'
                  : tab === 'mcp'
                    ? '保存仅写入配置，不测试连接。本地进程和远程请求将在显式检查或 Pi 会话加载时执行。'
                    : '扩展可以执行代码；Skills 也可能指示模型运行脚本。接入不会复制或删除原始源码。'}
              </p>
              <p>
                版本：{mode === 'package'
                  ? '以所填来源中的版本或 Git ref 为准；未指定则由 Pi 解析'
                  : '本地配置'}
              </p>
            </div>{/if}
          <div class="actions form-actions">
            <button
              disabled={busy}
              onclick={() => {
                if (preview) setPreview(false);
                else navigate(() => {});
              }}>{preview ? '返回编辑' : '取消'}</button
            ><button
              class="primary"
              disabled={busy ||
                !source.trim() ||
                (tab === 'mcp' && !name.trim())}
              onclick={() => {
                if (!preview) setPreview(true);
                else add();
              }}
              >{busy
                ? '处理中…'
                : preview
                  ? mode === 'package'
                    ? '确认安装'
                    : '确认接入'
                  : '检查并预览'}</button
            >
          </div>
        </div>
      {:else if selected}
        <PluginDetail item={selected} text={detail} loading={detailLoading} />
        {#if selected.kind === 'mcp'}<section class="detail-actions">
            <div>
              <h3>认证与连接</h3>
              <p>登录可能打开系统浏览器；不会修改其他会话。</p>
            </div>
            <div class="actions">
              <button
                disabled={busy}
                onclick={() => void command('login', selected!.id)}
                >登录（系统浏览器）</button
              ><button
                disabled={busy}
                onclick={() => void command('logout', selected!.id)}
                >退出登录</button
              >
            </div>
          </section>
          <section class="detail-actions danger-zone">
            <div>
              <h3>移除配置</h3>
              <p>只移除接入关系，保留服务器程序与凭据。</p>
            </div>
            <button
              class="destructive"
              disabled={busy}
              onclick={() => {
                confirm = selected;
              }}>移除配置</button
            >
          </section>{/if}
      {:else}
        <div class="section-heading">
          <div>
            <h2>{current.title}</h2>
            <p>{current.description}</p>
          </div>
          {#if tab === 'mcp'}<button
              disabled={busy}
              onclick={() => {
                confirm = {
                  id: 'diagnose',
                  kind: 'mcp',
                  name: '检查所有已启用 MCP',
                  description:
                    '会启动已配置的本地程序或连接远程服务。这是独立 CLI 检查，不是已有会话状态。',
                  source: '',
                  scope: 'global',
                  enabled: true,
                  inherited: false,
                  overridden: false,
                  problem: null,
                };
              }}>检查连接</button
            >{/if}
        </div>
        {#if busy && !catalog}<div class="empty" role="status">
            正在读取本地插件…
          </div>
        {:else if rows.length === 0}<div class="empty">
            <span class="empty-icon"
              ><Icon name={current.icon} size={26} /></span
            >
            <h3>{search ? '没有匹配的插件' : `还没有${current.title}`}</h3>
            <p>
              {search
                ? '试试其他名称、描述或来源。'
                : '接入你信任的来源，让 Pi 更贴合你的工作。'}
            </p>
          </div>
        {:else}<div class="plugin-list">
            {#each groups as group}
              {#if group.label}<h3 class="group-label">
                  {group.label}<small>{group.items.length}</small>
                </h3>{/if}
              {#each group.items as item (`${item.kind}:${item.scope}:${item.id}`)}<div
                  class="plugin-row"
                  class:disabled-row={!item.enabled}
                >
                  <span class="type-icon"
                    ><Icon
                      name={item.kind === 'skills'
                        ? 'file'
                        : item.kind === 'packages'
                          ? 'folder'
                          : 'plug'}
                      size={20}
                    /></span
                  ><button
                    class="row-main"
                    onclick={(event) => void inspect(item, event.currentTarget)}
                    ><strong
                      >{item.name}{#if item.kind === 'packages'}<small
                          >安装包</small
                        >{/if}</strong
                    ><span class="description"
                      >{item.description || '查看来源与详情'}</span
                    ><span class="meta"
                      >{item.scope === 'global'
                        ? '全局'
                        : '项目'}{item.inherited && project
                        ? ' · 继承'
                        : ''}{item.overridden ? ' · 项目覆盖' : ''} · {item.kind ===
                      'mcp'
                        ? '尚未检查会话连接'
                        : '磁盘配置'}</span
                    ><span class="detail-cue" aria-hidden="true"
                      >查看详情 ›</span
                    ></button
                  >
                  <div class="row-actions">
                    <span class:problem={!!item.problem} class="state"
                      >{item.problem
                        ? '需检查'
                        : item.enabled
                          ? '已启用'
                          : '已停用'}</span
                    >{#if item.kind !== 'packages'}<button
                        class="toggle"
                        role="switch"
                        aria-checked={item.enabled}
                        aria-label={`${item.enabled ? '停用' : '启用'} ${item.name}${project && item.inherited ? '（仅此项目）' : ''}`}
                        disabled={busy}
                        onclick={() =>
                          void change({
                            kind: item.kind,
                            id: item.id,
                            action: item.enabled ? 'disable' : 'enable',
                          })}><span></span></button
                      >{:else}<button
                        disabled={busy}
                        onclick={() => {
                          confirm = item;
                        }}>管理</button
                      >{/if}{#if project && item.overridden}<button
                        disabled={busy}
                        onclick={() =>
                          void change({
                            kind: item.kind,
                            id: item.id,
                            action: 'inherit',
                          })}>恢复继承</button
                      >{/if}
                  </div>
                </div>{/each}
            {/each}
          </div>{/if}
      {/if}
      {#if confirm}<div
          class="feedback confirm"
          role="region"
          aria-label="插件操作确认"
        >
          <strong>{confirm.name}</strong>
          <p>
            {confirm.id === 'diagnose'
              ? confirm.description
              : confirm.kind === 'packages'
                ? '移除安装声明会影响该包的全部资源，包括扩展、Skills、提示词和主题；不会删除本地源码。更新可能执行安装脚本，固定版本不会自动升级。'
                : '移除后下次加载不再接入此服务。不会清除 OAuth 凭据或删除服务器程序。'}
          </p>
          <div class="actions">
            <button
              disabled={busy}
              onclick={() => {
                confirm = null;
              }}>取消</button
            >{#if confirm.kind === 'packages'}<button
                disabled={busy}
                onclick={() => void command('update', confirm!.id)}
                >确认更新</button
              >{/if}<button
              disabled={busy}
              onclick={() => {
                const item = confirm!;
                if (item.id === 'diagnose') {
                  confirm = null;
                  void command('diagnose');
                } else
                  void change({
                    kind: item.kind,
                    id: item.id,
                    action: 'remove',
                  });
              }}
              >{confirm.id === 'diagnose'
                ? '确认检查连接'
                : '确认移除配置'}</button
            >
          </div>
        </div>{/if}
      {#if pending.length}<section class="apply-panel" aria-label="待应用会话">
          <h3>配置已保存 · 等待会话应用</h3>
          <p>不打断任务；空闲后由你重新加载。未连接会话下次启动时读取。</p>
          {#each sessions.filter( (s) => pending.includes(s.runtimeId) ) as session}<div
            >
              <span>{session.sessionTitle || session.project}</span><button
                disabled={busy ||
                  session.run !== 'idle' ||
                  session.connection !== 'ready'}
                onclick={() => void apply(session)}
                >{session.run !== 'idle'
                  ? '等待任务结束'
                  : '重新加载此会话'}</button
              >
            </div>{/each}
        </section>{/if}
      <footer>
        <Icon name="info" size={15} /><span
          >{catalog?.warnings[0] ||
            '只管理本地 Pi 配置，不会自动执行第三方资源。'}</span
        >
      </footer>
    </div>
  </div>
</section>

<style>
  .header-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    justify-content: flex-end;
  }
  .plugins-page {
    display: flex;
    flex: 1;
    min-height: 0;
    flex-direction: column;
    color: var(--text);
    container-type: inline-size;
    --plugin-gutter: clamp(20px, 4cqi, 40px);
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 20px;
    padding: 30px
      max(
        var(--plugin-gutter),
        calc((100% - 1040px) / 2 + var(--plugin-gutter))
      )
      24px;
  }
  h1 {
    margin: 0;
    font-size: 28px;
    font-weight: 600;
  }
  p {
    color: var(--muted);
    font-size: 13px;
    line-height: 1.7;
    margin: 6px 0 0;
  }
  .eyebrow {
    color: var(--accent);
    font-size: 12px;
    margin: 0 0 6px;
  }
  button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    font-size: 13px;
  }
  nav {
    overflow-x: auto;
    display: flex;
    gap: 24px;
    border-bottom: 1px solid var(--border);
    padding: 0
      max(
        var(--plugin-gutter),
        calc((100% - 1040px) / 2 + var(--plugin-gutter))
      );
  }
  nav button {
    flex-shrink: 0;
    white-space: nowrap;
    border: 0;
    border-bottom: 2px solid transparent;
    border-radius: 0;
    background: transparent;
    padding: 12px 0 14px;
    color: var(--muted);
  }
  nav button.active {
    color: var(--accent);
    border-bottom-color: var(--accent);
  }
  small {
    font-size: 11px;
    border-radius: 6px;
    background: var(--surface);
    padding: 2px 6px;
    color: var(--muted);
  }
  .plugins-scroll {
    flex: 1;
    min-height: 0;
    overflow: auto;
    scrollbar-gutter: stable;
  }
  .content {
    max-width: 1040px;
    padding: 26px var(--plugin-gutter);
    margin: 0 auto;
  }
  .toolbar {
    display: flex;
    align-items: flex-end;
    gap: 10px;
    margin-bottom: 28px;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 7px;
    font-size: 12px;
    color: var(--muted);
    min-width: 0;
  }
  input,
  textarea {
    width: 100%;
    background: var(--input-surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 9px 12px;
    color: var(--text);
    font-size: 13px;
  }
  .scope {
    flex: 0 1 210px;
  }
  .search {
    position: relative;
    flex: 1;
  }
  .search :global(svg) {
    position: absolute;
    left: 12px;
    top: 12px;
    color: var(--muted);
  }
  .search input {
    padding-left: 36px;
  }
  .toolbar > button {
    min-height: 39px;
    flex-shrink: 0;
  }
  .section-heading {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 16px;
    gap: 16px;
  }
  h2 {
    font-size: 18px;
    font-weight: 600;
    margin: 0;
  }
  h3 {
    font-size: 14px;
    font-weight: 600;
    margin: 0;
  }
  .group-label {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 24px 0 0;
    padding-bottom: 10px;
    border-bottom: 1px solid var(--border);
    color: var(--muted);
    font-size: 12px;
  }
  .plugin-row {
    display: flex;
    align-items: center;
    gap: 14px;
    border-bottom: 1px solid var(--border);
    padding: 20px 4px;
  }
  .plugin-row:hover {
    background: color-mix(in srgb, var(--surface) 45%, transparent);
  }
  .type-icon,
  .empty-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--border);
    border-radius: 12px;
    width: 42px;
    height: 42px;
    color: var(--accent);
    background: var(--accent-soft);
    flex-shrink: 0;
  }
  .row-main {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 5px;
    border: 0;
    background: transparent;
    text-align: left;
    min-width: 0;
    flex: 1;
    padding: 0;
  }
  .row-main:hover {
    background: transparent;
  }
  strong {
    font-weight: 600;
  }
  .row-main strong {
    display: flex;
    align-items: center;
    gap: 8px;
    max-width: 100%;
    overflow-wrap: anywhere;
  }
  .description {
    font-size: 13px;
    color: var(--muted);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .meta {
    font-size: 12px;
    color: var(--muted);
  }
  .row-actions {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-shrink: 0;
    flex-wrap: wrap;
  }
  .state {
    font-size: 12px;
    color: var(--muted);
  }
  .problem {
    color: var(--warning);
  }
  .toggle {
    width: 38px;
    height: 24px;
    min-height: 24px;
    padding: 2px;
    background: var(--muted);
    border: 0;
    border-radius: 12px;
    justify-content: flex-start;
  }
  .toggle span {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: var(--bg);
  }
  .toggle[aria-checked='true'] {
    background: var(--accent);
    justify-content: flex-end;
  }
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    padding: 56px 16px;
    border: 1px dashed var(--border);
    border-radius: var(--radius-panel);
  }
  .empty-icon {
    margin-bottom: 16px;
    width: 52px;
    height: 52px;
  }
  .feedback {
    background: var(--surface);
    border: 1px solid var(--border);
    padding: 14px 16px;
    border-radius: 10px;
    font-size: 13px;
    line-height: 1.7;
    margin: 0 0 20px;
    overflow-wrap: anywhere;
  }
  .failure {
    color: var(--error);
  }
  .leave,
  .confirm {
    border-color: var(--warning);
  }
  .leave button {
    margin: 12px 8px 0 0;
  }
  .form-card {
    border: 1px solid var(--border);
    border-radius: var(--radius-panel);
    padding: 24px;
  }
  fieldset {
    margin: 24px 0;
    padding: 0;
    border: 0;
    display: grid;
    gap: 18px;
  }
  textarea {
    resize: vertical;
    font-family: var(--font-mono);
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    flex-wrap: wrap;
    gap: 10px;
    margin-top: 18px;
  }
  .apply-panel {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 18px;
    margin-top: 24px;
  }
  .apply-panel > div {
    display: flex;
    justify-content: space-between;
    gap: 14px;
    align-items: center;
    margin-top: 12px;
  }
  .apply-panel span {
    overflow-wrap: anywhere;
    min-width: 0;
  }
  footer {
    display: flex;
    align-items: flex-start;
    gap: 9px;
    color: var(--muted);
    font-size: 12px;
    line-height: 1.7;
    margin-top: 28px;
  }
  footer :global(svg) {
    flex-shrink: 0;
    margin-top: 3px;
  }
  .subnav {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 20px;
  }
  .subnav > span {
    display: flex;
    align-items: center;
    gap: 7px;
    color: var(--muted);
    font-size: 12px;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .subnav button {
    flex-shrink: 0;
    padding-left: 0;
  }
  .form-heading {
    display: flex;
    align-items: center;
    gap: 14px;
  }
  .form-card {
    max-width: 760px;
    margin: 0 auto;
    box-shadow: 0 2px 10px #00000003;
  }
  .form-steps {
    display: flex;
    gap: 24px;
    list-style: none;
    padding: 18px 0;
    margin: 20px 0 0;
    border-block: 1px solid var(--border);
  }
  .form-steps li {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: var(--muted);
  }
  .form-steps li > span {
    display: grid;
    place-items: center;
    width: 23px;
    height: 23px;
    border-radius: 50%;
    background: var(--surface);
  }
  .form-steps li.current {
    color: var(--accent);
    font-weight: 600;
  }
  .form-steps li.current > span {
    background: var(--accent-soft);
  }
  .preview-summary {
    display: grid;
    grid-template-columns: 90px minmax(0, 1fr);
    gap: 18px;
    padding: 24px 0;
    margin: 0;
    font-size: 13px;
  }
  .preview-summary dt {
    color: var(--muted);
  }
  .preview-summary dd {
    margin: 0;
    overflow-wrap: anywhere;
    line-height: 1.7;
  }
  .form-actions {
    border-top: 1px solid var(--border);
    padding-top: 20px;
  }
  fieldset[hidden] {
    display: none;
  }
  .status,
  .failure {
    display: flex;
    gap: 10px;
    align-items: flex-start;
  }
  .feedback :global(svg) {
    flex-shrink: 0;
    margin-top: 3px;
  }
  .failure {
    background: color-mix(in srgb, var(--error) 5%, var(--bg));
    border-color: color-mix(in srgb, var(--error) 22%, var(--border));
  }
  .failure p {
    color: var(--text);
    margin-top: 3px;
  }
  .confirm {
    margin-top: 20px;
    background: var(--warning-soft);
    border-color: color-mix(in srgb, var(--warning) 25%, var(--border));
  }
  .detail-actions {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 20px;
    padding: 22px 0;
    border-bottom: 1px solid var(--border);
  }
  .detail-actions .actions {
    margin: 0;
  }
  .danger-zone {
    border-bottom: 0;
  }
  .destructive {
    color: var(--error);
  }
  .detail-cue {
    color: var(--accent);
    font-size: 11px;
    opacity: 0;
  }
  .row-main:hover .detail-cue,
  .row-main:focus-visible .detail-cue {
    opacity: 1;
  }
  .row-main:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 5px;
    border-radius: 4px;
  }
  .disabled-row .type-icon {
    background: var(--surface);
    color: var(--muted);
  }
  @container (max-width:680px) {
    .toolbar {
      flex-wrap: wrap;
    }
    .scope {
      flex-basis: 100%;
    }
    .plugin-row {
      flex-wrap: wrap;
    }
    .row-actions {
      margin-left: 56px;
    }
    .detail-actions {
      flex-wrap: wrap;
    }
  }
  @container (max-width:600px) {
    header {
      flex-direction: column;
      align-items: flex-start;
      gap: 14px;
    }
    .header-actions {
      justify-content: flex-start;
    }
  }
  @container (max-width:400px) {
    header {
      padding: 16px 20px;
    }
    header p {
      display: none;
    }
    h1 {
      font-size: 24px;
      white-space: nowrap;
    }
    nav {
      gap: 16px;
    }
  }
  @media (max-width: 1100px) {
    header {
      padding: 24px;
    }
    nav {
      padding: 0 24px;
    }
    .content {
      padding: 24px;
    }
    .toolbar {
      flex-wrap: wrap;
    }
    .search {
      min-width: 180px;
    }
    .plugin-row {
      flex-wrap: wrap;
    }
    .row-actions {
      margin-left: 56px;
    }
  }
  @media (max-width: 600px) {
    header {
      align-items: flex-start;
      padding: 20px;
    }
    .header-actions {
      flex-shrink: 0;
    }
    .content {
      padding: 20px;
    }
    nav {
      padding: 0 20px;
      gap: 20px;
    }
    .scope {
      flex-basis: 100%;
    }
    .form-card {
      padding: 18px;
    }
  }
</style>
