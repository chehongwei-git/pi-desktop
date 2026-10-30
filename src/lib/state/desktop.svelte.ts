/** 应用门面：组件只调用用户意图；集中连接状态、草稿、事件确认与切换事务。 */
import { bridge, errorMessage, type Bridge } from '../client';
import { parseBuiltin } from '../commands';
import { terminalText } from '../terminal-text';
import { reduceEvents } from './reducer';
import {
  defaultSettings,
  type Action,
  type Command,
  type ConnectionState,
  type ExtensionRequest,
  type HistoryPage,
  type Message,
  type Model,
  type RunState,
  type SessionSummary,
  type Settings,
  type Snapshot,
  type Wakeup,
} from '../types';

export class Desktop {
  settings = $state<Settings>({
    ...defaultSettings,
    recentProjects: [],
    projectOrder: [],
    pinnedSessions: [],
    extraPath: [],
  });
  connection = $state<ConnectionState>('disconnected');
  run = $state<RunState>('idle');
  project = $state('');
  runtimeId = $state('');
  version = $state('');
  messages = $state<Message[]>([]);
  toolViews = $state<Record<string, Record<string, boolean>>>({});
  toggleTool(id: string, section: string): void {
    const view = this.toolViews[id] ?? {};
    this.toolViews[id] = { ...view, [section]: !view[section] };
  }
  sessions = $state<SessionSummary[]>([]);
  loadingSessions = $state(false);
  pinSaving = $state(false);
  get pinnedSessions(): SessionSummary[] {
    const sessions = new Map(
      this.sessions.map((session) => [session.path, session]),
    );
    return this.settings.pinnedSessions.flatMap((path) => {
      const session = sessions.get(path);
      return session ? [session] : [];
    });
  }
  isPinned(path: string): boolean {
    return this.settings.pinnedSessions.includes(path);
  }
  /** 先持久化再更新界面；保存失败保留原置顶状态。 */
  async togglePin(path: string): Promise<void> {
    if (this.pinSaving) return;
    this.pinSaving = true;
    try {
      const pinnedSessions = this.isPinned(path)
        ? this.settings.pinnedSessions.filter((item) => item !== path)
        : [...this.settings.pinnedSessions, path];
      await this.api.save({
        ...$state.snapshot(this.settings),
        pinnedSessions,
      });
      this.settings.pinnedSessions = pinnedSessions;
    } finally {
      this.pinSaving = false;
    }
  }
  projectOrderSaving = $state(false);
  private sentAt = $state<Record<string, string>>({});
  private compareSessions(a: SessionSummary, b: SessionSummary): number {
    const activity = (session: SessionSummary) => {
      const stored = session.lastPromptAt || '';
      const local = this.sentAt[this.sessionKey(session.path)] || '';
      return local > stored ? local : stored;
    };
    return (
      activity(b).localeCompare(activity(a)) ||
      (b.timestamp || '').localeCompare(a.timestamp || '') ||
      this.sessionKey(a.path).localeCompare(this.sessionKey(b.path))
    );
  }
  get recentSessions(): SessionSummary[] {
    return [...this.sessions].sort((a, b) => this.compareSessions(a, b));
  }
  /** 保存完整项目顺序，搜索和折叠只改变可见范围。 */
  async moveProject(
    source: string,
    target: string,
    after = false,
  ): Promise<void> {
    if (this.projectOrderSaving) return;
    const order = this.projects.map((project) => project.path);
    const from = order.findIndex(
      (path) => this.projectKey(path) === this.projectKey(source),
    );
    if (from < 0 || this.projectKey(source) === this.projectKey(target)) return;
    const [path] = order.splice(from, 1);
    const to = order.findIndex(
      (item) => this.projectKey(item) === this.projectKey(target),
    );
    if (to < 0) return;
    order.splice(to + (after ? 1 : 0), 0, path);
    this.projectOrderSaving = true;
    try {
      await this.api.save({
        ...$state.snapshot(this.settings),
        projectOrder: order,
      });
      this.settings.projectOrder = order;
    } finally {
      this.projectOrderSaving = false;
    }
  }
  expandedProjects = $state<string[]>([]);
  /** 与 Pi header.cwd 分组；Windows 路径忽略大小写与分隔符差异。 */
  projectKey(path: string): string {
    const normalized = path.replace(/\\/g, '/').replace(/\/$/, '');
    return /^[a-z]:\//i.test(normalized)
      ? normalized.toLowerCase()
      : normalized;
  }
  get projects(): { path: string; sessions: SessionSummary[] }[] {
    const groups = new Map<
      string,
      { path: string; sessions: SessionSummary[] }
    >();
    for (const session of this.sessions) {
      if (!session.cwd) continue;
      const key = this.projectKey(session.cwd);
      if (!groups.has(key))
        groups.set(key, { path: session.cwd, sessions: [] });
      groups.get(key)!.sessions.push(session);
    }
    for (const path of [this.project, ...this.settings.recentProjects]) {
      if (path && !groups.has(this.projectKey(path)))
        groups.set(this.projectKey(path), { path, sessions: [] });
    }
    for (const group of groups.values()) {
      group.sessions.sort((a, b) => this.compareSessions(a, b));
    }
    const rank = new Map(
      this.settings.projectOrder.map((path, index) => [
        this.projectKey(path),
        index,
      ]),
    );
    return [...groups.values()].sort(
      (a, b) =>
        (rank.get(this.projectKey(a.path)) ?? Infinity) -
          (rank.get(this.projectKey(b.path)) ?? Infinity) ||
        this.projectKey(a.path).localeCompare(this.projectKey(b.path)),
    );
  }
  isExpanded(project: string): boolean {
    return this.expandedProjects.includes(this.projectKey(project));
  }
  expandProject(project: string): void {
    if (!this.isExpanded(project))
      this.expandedProjects = [
        ...this.expandedProjects,
        this.projectKey(project),
      ];
  }
  toggleProject(project: string): void {
    if (this.isExpanded(project))
      this.expandedProjects = this.expandedProjects.filter(
        (key) => key !== this.projectKey(project),
      );
    else this.expandProject(project);
  }
  snapshot = $state<Snapshot>({});
  models = $state<Model[]>([]);
  levels = $state<string[]>([]);
  commands = $state<Command[]>([]);
  builtinRequest = $state<{ name: string; args: string } | null>(null);
  draft = $state('');
  notice = $state('');
  error = $state('');
  submitting = $state(false);
  loadingHistory = $state(false);
  openingSession = $state<{ path: string; title: string } | null>(null);
  private currentSessionTitle = $state('');
  /** 当前标题不依赖索引刷新是否暂时缺项；Pi 返回名称时仍以其为准。 */
  get sessionTitle(): string {
    if (this.openingSession) return this.openingSession.title;
    const session = this.sessions.find(
      (item) =>
        this.sessionKey(item.path) ===
        this.sessionKey(this.snapshot.sessionFile ?? ''),
    );
    return (
      this.snapshot.sessionName ||
      session?.name ||
      this.currentSessionTitle ||
      session?.preview ||
      session?.timestamp ||
      '新对话'
    );
  }
  /** Windows RPC 与磁盘索引可使用不同分隔符、大小写和长路径前缀。 */
  private sessionKey(path: string): string {
    const normalized = path.replace(/\\/g, '/').replace(/^\/\/\?\//, '');
    return /^[a-z]:\//i.test(normalized) || normalized.startsWith('//')
      ? normalized.toLowerCase()
      : normalized;
  }
  private sessionLabel(path: string): string {
    const session = this.sessions.find(
      (item) => this.sessionKey(item.path) === this.sessionKey(path),
    );
    return session?.name || session?.preview || session?.timestamp || '';
  }
  before = $state(0);
  hasMore = $state(false);
  extensions = $state<ExtensionRequest[]>([]);
  statuses = $state<Record<string, string>>({});
  widgets = $state<Record<string, string[]>>({});
  recovered = $state<string[]>([]);
  queued = $state<string[]>([]);
  pendingSwitch = $state<{
    label: string;
    execute: () => Promise<void>;
    waiting: boolean;
  } | null>(null);
  private connectionTask: Promise<void> | null = null;
  private ack = 0;
  private pumpTask: Promise<void> | null = null;
  private generation = 0;
  private searchGeneration = 0;
  private drafts = new Map<string, string>();
  private visible = new Set<string>();
  private accessed = new Map<string, number>();
  private accessSerial = 0;
  private submissionSerial = 0;
  /** 虚拟列表报告挂载窗口；这些消息不被缓存淘汰，访问顺序用于 LRU。 */
  pinVisible(ids: string[]): void {
    this.visible = new Set(ids);
    for (const id of ids) this.accessed.set(id, ++this.accessSerial);
  }
  private stopTimer?: ReturnType<typeof setTimeout>;
  private stopping = false;
  /** 依赖注入仅用在真正需要替换的 IPC 边界，不建立全局 DI 容器。 */
  constructor(private api: Bridge = bridge) {}
  /** 当前会话草稿键；空白新会话也能在项目之间独立恢复。 */
  private draftKey(): string {
    return `${this.project}:${this.snapshot.sessionFile ?? 'new'}`;
  }
  /** 配置初始化失败仍可进入设置修复；普通浏览器预览给出明确桌面环境说明。 */
  async init(): Promise<void> {
    try {
      const settings = await this.api.settings();
      this.settings = {
        ...defaultSettings,
        ...settings,
        pinnedSessions: settings.pinnedSessions ?? [],
        projectOrder: settings.projectOrder ?? [],
        zoom: Number.isFinite(settings.zoom)
          ? Math.max(80, Math.min(150, settings.zoom))
          : defaultSettings.zoom,
      };
      await this.refreshSessions();
      await this.connect(this.settings.recentProjects[0] ?? '');
    } catch (error) {
      this.error = errorMessage(error);
    }
  }
  /** 用户可见错误统一入口；不吞掉业务失败，也不自动重发副作用请求。 */
  async guard(work: () => Promise<void>): Promise<void> {
    this.error = '';
    try {
      await work();
    } catch (error) {
      this.error = errorMessage(error);
    }
  }
  /** 所有业务动作自动携带 runtimeId，避免旧窗口请求误入新进程。 */
  async action<T = unknown>(action: Action): Promise<T> {
    return this.api.action<T>(this.runtimeId, action);
  }
  /** 项目/历史切换通过此事务入口；运行时由弹层明确选择停止、等待或取消。 */
  requestSwitch(label: string, execute: () => Promise<void>): void {
    if (this.openingSession) return;
    if (this.run !== 'idle') {
      this.pendingSwitch = { label, execute, waiting: false };
      return;
    }
    void this.guard(execute);
  }
  /** 等待模式只登记意图，不提前更改项目、列表选中状态或草稿。 */
  waitToSwitch(): void {
    if (this.pendingSwitch) this.pendingSwitch.waiting = true;
  }
  /** 必须等待停止成功；错误时保持原会话与待切换意图，供用户恢复。 */
  async stopAndSwitch(): Promise<void> {
    await this.stop();
    if (this.run === 'idle') await this.executePending();
  }
  /** 先取走意图避免 settled/按钮重复执行；已取消的意图不会再运行。 */
  private async executePending(): Promise<void> {
    const next = this.pendingSwitch;
    this.pendingSwitch = null;
    if (next) await this.guard(next.execute);
  }
  /** 连接时先安装通知，starting 阶段也处理扩展信任/输入请求。 */
  connect(project: string): Promise<void> {
    if (this.connectionTask)
      return this.connectionTask.then(() => this.connect(project));
    this.connectionTask = this.connectProject(project).finally(() => {
      this.connectionTask = null;
    });
    return this.connectionTask;
  }
  private async connectProject(project: string): Promise<void> {
    this.drafts.set(this.draftKey(), this.draft);
    const generation = ++this.generation;
    this.connection = 'starting';
    this.ack = 0;
    this.runtimeId = '';
    this.extensions = [];
    this.commands = [];
    this.error = '';
    try {
      const connected = await this.api.connect(project, (event) =>
        this.receive(event, generation),
      );
      if (generation !== this.generation) return;
      this.runtimeId = connected.runtimeId;
      this.project = connected.project;
      this.expandProject(this.project);
      this.version = connected.version;
      this.snapshot = connected.snapshot;
      this.currentSessionTitle = '';
      this.connection = 'ready';
      this.messages = [];
      this.toolViews = {};
      this.accessed.clear();
      this.visible.clear();
      this.run = connected.snapshot.isStreaming ? 'running' : 'idle';
      this.draft = this.drafts.get(this.draftKey()) ?? '';
      this.settings.recentProjects = [
        this.project,
        ...this.settings.recentProjects.filter(
          (p) => this.projectKey(p) !== this.projectKey(this.project),
        ),
      ].slice(0, 20);
      await this.api.save($state.snapshot(this.settings));
      if (!connected.verified)
        this.notice = `Pi ${connected.version} 未经本版验证，将按 RPC 能力连接。`;
      await Promise.all([
        this.refreshMetadata(),
        this.refreshHistory(),
        this.refreshSessions(),
      ]);
    } catch (error) {
      if (generation === this.generation) {
        this.connection = 'failed';
        this.error = errorMessage(error);
      }
    }
  }
  /** Channel 唤醒只触发一次拉取循环；旧 runtime/generation 的事件全部忽略。 */
  private receive(event: Wakeup, generation: number): void {
    if (generation !== this.generation) return;
    if (!this.runtimeId && this.connection === 'starting')
      this.runtimeId = event.runtimeId;
    if (event.runtimeId !== this.runtimeId) return;
    if (event.type === 'failed') {
      this.connection = 'failed';
      this.run = 'idle';
      this.error = errorMessage(event.error);
      return;
    }
    void this.drain(generation);
  }
  /** 共用拉取任务使切换可等待 reset 事件处理完成，避免新历史被迟到 reset 清空。 */
  private drain(generation = this.generation): Promise<void> {
    if (!this.pumpTask)
      this.pumpTask = this.pump(generation).finally(() => {
        this.pumpTask = null;
      });
    return this.pumpTask;
  }
  /** 只有 reducer 与扩展处理成功后才推进 ack；失败可重拉，不静默跳过。 */
  private async pump(generation: number): Promise<void> {
    try {
      while (generation === this.generation && this.runtimeId) {
        const batch = await this.api.events(this.runtimeId, this.ack);
        if (
          generation !== this.generation ||
          batch.runtimeId !== this.runtimeId
        )
          break;
        if (!batch.events.length) break;
        const previous = this.run;
        reduceEvents(this, batch.events);
        for (const event of batch.events) {
          if (event.type === 'extension') this.extension(event.request);
          if (event.type === 'notice') this.notice = event.message;
          if (event.type === 'metadata') {
            if (event.data.type === 'session_info_changed')
              this.snapshot.sessionName = event.data.name;
            if (event.data.type === 'thinking_level_changed')
              this.snapshot.thinkingLevel = event.data.level;
            if (event.data.type === 'queue_update')
              this.queued = [
                ...(event.data.steering ?? []),
                ...(event.data.followUp ?? []),
              ];
          }
        }
        this.ack = batch.sequence;
        if (batch.events.some((event) => event.type === 'message'))
          this.trimCache();
        if (
          (previous !== 'idle' && this.run === 'idle') ||
          batch.events.some(
            (event) =>
              event.type === 'message' && event.message.role === 'user',
          )
        ) {
          if (this.run === 'idle') clearTimeout(this.stopTimer);
          void this.guard(async () => {
            await this.syncState();
            await this.refreshSessions();
          });
          if (this.run === 'idle' && this.pendingSwitch?.waiting)
            void this.executePending();
        }
      }
    } catch (error) {
      if (generation === this.generation && this.connection !== 'failed')
        this.error = errorMessage(error);
    }
  }
  /** 正文预算 8MiB，挂载窗口与流式块除外；仅淘汰可由引用重载的文本。 */
  private trimCache(): void {
    let bytes = this.messages.reduce(
      (sum, m) => sum + (m.text.length + m.thinking.length) * 2,
      0,
    );
    const candidates = this.messages.filter(
      (message) =>
        message.contentRef &&
        !this.visible.has(message.id) &&
        message.status !== 'streaming',
    );
    candidates.sort(
      (a, b) => (this.accessed.get(a.id) ?? 0) - (this.accessed.get(b.id) ?? 0),
    );
    for (const message of candidates) {
      if (bytes <= 8 * 1024 * 1024) break;
      bytes -= message.text.length * 2;
      message.text = '';
    }
  }
  /** 流式阶段通知与对话框分离，fire-and-forget 不发送多余响应。 */
  private extension(request: ExtensionRequest): void {
    // 清理呈现字段，选项值保持原样以便扩展精确匹配返回值。
    request = {
      ...request,
      title:
        request.title === undefined ? undefined : terminalText(request.title),
      message:
        request.message === undefined
          ? undefined
          : terminalText(request.message),
    };
    if (['select', 'confirm', 'input', 'editor'].includes(request.method)) {
      if (this.stopping) {
        void this.guard(async () => {
          await this.action({
            type: 'extension_response',
            id: request.id,
            value: { cancelled: true },
          });
        });
        return;
      }
      if (!this.extensions.some((e) => e.id === request.id))
        this.extensions.push(request);
      return;
    }
    if (request.method === 'notify') this.notice = request.message ?? '';
    if (request.method === 'setStatus' && request.statusKey)
      this.statuses[request.statusKey] = terminalText(request.statusText ?? '');
    if (request.method === 'setWidget' && request.widgetKey)
      this.widgets[request.widgetKey] = (request.widgetLines ?? []).map(
        terminalText,
      );
    if (request.method === 'setTitle')
      document.title = request.title || 'Pi Desktop';
    if (request.method === 'set_editor_text') {
      if (this.draft) this.recovered.push(this.draft);
      this.draft = request.text ?? '';
    }
  }
  /** 扩展响应取原 request ID；组件超时/取消竞态只会消费该请求一次。 */
  async respond(
    request: ExtensionRequest,
    value: { value?: string; confirmed?: boolean; cancelled?: boolean },
  ): Promise<void> {
    if (!this.extensions.some((e) => e.id === request.id)) return;
    this.extensions = this.extensions.filter((e) => e.id !== request.id);
    await this.action({ type: 'extension_response', id: request.id, value });
  }
  /** 查询模型/命令可失败降级，不影响已建立的文本会话。 */
  async refreshMetadata(): Promise<void> {
    const results = await Promise.allSettled([
      this.action<{ models: Model[] }>({ type: 'models' }),
      this.action<{ levels: string[] }>({ type: 'thinking_levels' }),
      this.action<{ commands: Command[] }>({ type: 'commands' }),
    ]);
    if (results[0].status === 'fulfilled')
      this.models = results[0].value.models ?? [];
    if (results[1].status === 'fulfilled')
      this.levels = results[1].value.levels ?? [];
    if (results[2].status === 'fulfilled')
      this.commands = results[2].value.commands ?? [];
  }
  /** 状态以 Pi 查询结果为准，不能从 accepted 或 agent_end 推断完成。 */
  async syncState(): Promise<void> {
    const generation = this.generation;
    const snapshot = await this.action<Snapshot>({ type: 'state' });
    if (generation === this.generation) this.snapshot = snapshot;
  }
  /** 全局索引支持启动时浏览全部项目；搜索在摘要上本地进行。 */
  async refreshSessions(): Promise<void> {
    const generation = ++this.searchGeneration;
    this.loadingSessions = true;
    try {
      const sessions = await this.api.sessions('', '');
      if (generation === this.searchGeneration) this.sessions = sessions;
    } finally {
      if (generation === this.searchGeneration) this.loadingSessions = false;
    }
  }
  /** 已有历史直接交给 Pi 切换，Pi 根据 header.cwd 重建项目服务。 */
  async openSession(project: string, path: string): Promise<void> {
    if (this.openingSession) return;
    this.openingSession = {
      path,
      title: this.sessionLabel(path) || '新会话',
    };
    try {
      if (this.connectionTask) await this.connectionTask;
      if (this.connection !== 'ready') await this.connect(project);
      if (this.connection !== 'ready') return;
      await this.switchSession(path, project);
    } finally {
      this.openingSession = null;
    }
  }
  /** 空项目由宿主解析为系统用户目录；已有连接时继续在当前项目新建。 */
  async newSession(project = this.project): Promise<void> {
    if (this.connectionTask) await this.connectionTask;
    if (
      this.connection !== 'ready' ||
      this.projectKey(this.project) !== this.projectKey(project)
    )
      await this.connect(project);
    else await this.switchSession();
  }
  /** 历史恢复由宿主投影与分页；首次只接收最后 50 条。 */
  async refreshHistory(before?: number): Promise<void> {
    const generation = this.generation;
    this.loadingHistory = true;
    try {
      const page = await this.action<HistoryPage>({ type: 'history', before });
      if (generation !== this.generation) return;
      this.messages =
        before === undefined
          ? page.messages
          : [...page.messages, ...this.messages];
      this.before = page.before;
      this.hasMore = page.hasMore;
    } finally {
      if (generation === this.generation) this.loadingHistory = false;
    }
  }
  /** 发送接受前保留原草稿，超时绝不自动重发；用户消息由 Pi 权威事件插入。 */
  async send(mode?: 'steer' | 'followUp'): Promise<void> {
    if (
      !this.draft.trim() ||
      this.submitting ||
      this.openingSession ||
      this.connection !== 'ready'
    )
      return;
    const text = this.draft;
    const builtin = parseBuiltin(text);
    if (builtin) {
      if (this.run !== 'idle') {
        throw new Error('请等待当前任务完成或停止任务后再执行内置命令。');
      }
      if (builtin.name === 'compact') {
        const generation = this.generation;
        const session = this.snapshot.sessionFile;
        this.submitting = true;
        this.run = 'compacting';
        this.notice = '正在压缩会话上下文…';
        try {
          await this.action({
            type: 'compact',
            instructions: builtin.args || undefined,
          });
          if (
            generation !== this.generation ||
            session !== this.snapshot.sessionFile
          )
            return;
          if (this.draft === text) this.draft = '';
          await this.refreshCommandSession();
          this.notice = '会话上下文已压缩。';
        } catch (error) {
          if (generation === this.generation) this.notice = '';
          throw error;
        } finally {
          if (generation === this.generation) {
            // 手动 compact 是独立 RPC 操作，完成后不会保证收到 agent_settled。
            try {
              await this.drain();
              await this.syncState();
              this.run = this.snapshot.isCompacting
                ? 'compacting'
                : this.snapshot.isStreaming
                  ? 'running'
                  : 'idle';
            } catch (error) {
              this.notice =
                '压缩状态查询失败，请检查连接后确认结果；不要自动重复执行。';
              throw error;
            } finally {
              this.submitting = false;
            }
          } else {
            this.submitting = false;
          }
        }
        return;
      }
      this.builtinRequest = builtin;
      if (this.draft === text) this.draft = '';
      return;
    }
    const sessionFile = this.snapshot.sessionFile;
    const sentAt = new Date().toISOString();
    const delivery = mode ?? (this.run !== 'idle' ? 'steer' : undefined);
    const pendingId = delivery
      ? `pending-${++this.submissionSerial}`
      : undefined;
    if (pendingId && delivery) {
      // 用新数组使 reducer 的 ID 索引同步包含本地占位。
      this.messages = [
        ...this.messages,
        {
          id: pendingId,
          role: 'user',
          text,
          thinking: '',
          contentRef: null,
          status: 'done',
          name: null,
          delivery: { mode: delivery, state: 'sending' },
        },
      ];
    }
    this.submitting = true;
    try {
      await this.action({ type: 'prompt', message: text, mode: delivery });
      if (sessionFile) this.sentAt[this.sessionKey(sessionFile)] = sentAt;
      const pending = this.messages.find((message) => message.id === pendingId);
      if (pending?.delivery) pending.delivery.state = 'queued';
      if (this.draft === text) this.draft = '';
      if (delivery)
        this.notice =
          delivery === 'steer'
            ? '引导消息已提交'
            : '后续消息已提交，将在当前任务完成后处理';
    } catch (error) {
      if (pendingId)
        this.messages = this.messages.filter(
          (message) => message.id !== pendingId,
        );
      throw error;
    } finally {
      this.submitting = false;
    }
  }
  /** 分支与压缩改变 Pi 的历史，先使宿主投影失效，再按权威历史恢复。 */
  async refreshCommandSession(): Promise<void> {
    await this.drain();
    this.toolViews = {};
    this.accessed.clear();
    this.visible.clear();
    await this.syncState();
    this.project = this.snapshot.cwd || this.project;
    await Promise.all([
      this.refreshHistory(),
      this.refreshMetadata(),
      this.refreshSessions(),
    ]);
  }
  /** 停止先清队列再 abort；5 秒后提供强制断开入口，保留草稿和当前消息。 */
  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    const generation = this.generation;
    const runtimeId = this.runtimeId;
    this.run = 'aborting';
    this.stopTimer = setTimeout(() => {
      if (this.run === 'aborting')
        this.notice = '停止超过 5 秒，可继续等待或强制关闭 Pi。';
    }, 5000);
    try {
      // 先释放扩展等待者；abort 可能正在等待 agent_end 钩子完成。
      await Promise.all(
        [...this.extensions].map((request) =>
          this.respond(request, { cancelled: true }),
        ),
      );
      const cleared = await this.api.action<{
        steering?: string[];
        followUp?: string[];
      }>(runtimeId, { type: 'stop' });
      if (generation !== this.generation) return;
      this.recovered.push(
        ...(cleared.steering ?? []),
        ...(cleared.followUp ?? []),
      );
      this.messages = this.messages.filter((message) => !message.delivery);
      this.queued = [];
    } finally {
      clearTimeout(this.stopTimer);
      this.stopping = false;
      if (generation === this.generation && this.connection === 'ready') {
        try {
          await this.syncState();
          this.run =
            this.snapshot.isStreaming || this.snapshot.isCompacting
              ? 'aborting'
              : 'idle';
          if (this.run === 'aborting')
            this.notice = 'Pi 仍未停止，可继续等待或强制关闭 Pi。';
        } catch {
          this.notice =
            '无法确认停止状态，可继续等待或强制关闭 Pi；草稿已保留。';
        }
      }
    }
  }
  /** 新建/切换只在成功且未被扩展取消后提交 UI 状态。 */
  async switchSession(path?: string, project = this.project): Promise<void> {
    if (!this.project) return;
    const title = path
      ? this.sessionLabel(path) || this.openingSession?.title || ''
      : '';
    this.drafts.set(this.draftKey(), this.draft);
    const result = await this.action<{ cancelled: boolean }>(
      path ? { type: 'switch_session', path } : { type: 'new_session' },
    );
    if (result.cancelled) {
      this.notice = '切换已被 Pi 扩展取消';
      return;
    }
    this.currentSessionTitle = title;
    this.toolViews = {};
    await this.drain();
    this.accessed.clear();
    this.visible.clear();
    await this.syncState();
    const previousProject = this.project;
    this.project = this.snapshot.cwd || project;
    this.expandProject(this.project);
    await Promise.all([
      this.refreshHistory(),
      this.refreshMetadata(),
      this.refreshSessions(),
    ]);
    this.draft = this.drafts.get(this.draftKey()) ?? '';
    if (this.projectKey(previousProject) !== this.projectKey(this.project)) {
      this.settings.recentProjects = [
        this.project,
        ...this.settings.recentProjects.filter(
          (item) => this.projectKey(item) !== this.projectKey(this.project),
        ),
      ].slice(0, 20);
      await this.api.save($state.snapshot(this.settings));
    }
  }
  /** 强制断开不是重试，不重发任何提示词。 */
  async disconnect(force = false): Promise<void> {
    this.connection = 'stopping';
    ++this.generation;
    await this.api.disconnect(force);
    this.connection = 'disconnected';
    this.runtimeId = '';
    this.run = 'idle';
    this.extensions = [];
  }
  /** 重命名只针对已打开会话，并由 Pi 负责写入。 */
  async rename(name: string): Promise<void> {
    if (!name.trim()) return;
    await this.action({ type: 'rename', name: name.trim() });
    this.currentSessionTitle = name.trim();
    await this.syncState();
    await this.refreshSessions();
  }
  /** 模型切换后重读思考等级，避免沿用新模型不支持的选项。 */
  async setModel(key: string): Promise<void> {
    const model = this.models.find((m) => `${m.provider}/${m.id}` === key);
    if (!model) return;
    await this.action({
      type: 'set_model',
      provider: model.provider,
      model: model.id,
    });
    await this.syncState();
    await this.refreshMetadata();
  }
  /** 读取前 64KiB 用于虚拟列表重新挂载，全文由分块对话框浏览。 */
  async loadPreview(message: Message): Promise<void> {
    if (!message.contentRef || message.text) return;
    const page = await this.api.content(this.runtimeId, message.contentRef, 0);
    message.text = page.text;
    message.truncated = !page.done;
    this.accessed.set(message.id, ++this.accessSerial);
    this.trimCache();
  }
  /** 分块正文查询保留明确的 runtime 所有权。 */
  async readContent(id: string, offset: number) {
    const generation = this.generation;
    const session = this.snapshot.sessionFile;
    const runtime = this.runtimeId;
    const page = await this.api.content(runtime, id, offset);
    if (
      generation !== this.generation ||
      runtime !== this.runtimeId ||
      session !== this.snapshot.sessionFile
    )
      throw new Error('会话已切换，正文读取已取消');
    return page;
  }
  /** 配置更新原子持久化，运行时配置需重新连接才生效。 */
  async saveSettings(settings: Settings): Promise<void> {
    await this.api.save(settings);
    this.settings = settings;
    await this.refreshSessions();
  }
  /** 连接诊断只返回版本与路径，不读凭据。 */
  detect(settings: Settings) {
    return this.api.detect(settings);
  }
}
