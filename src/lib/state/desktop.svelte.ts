/** 应用门面：组件只调用用户意图；集中连接状态、草稿、事件确认与切换事务。 */
import { bridge, errorMessage, type Bridge } from '../client';
import { parseBuiltin } from '../commands';
import type { ModelSettings, ProviderConfig } from '../model-config';
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
  type MessageImage,
  type Model,
  type RunState,
  type SessionStats,
  type SessionSummary,
  type Settings,
  type SidebarItem,
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
  sidebarSaving = $state(false);
  sidebarFeedback = $state('');
  sidebarError = $state('');
  sidebarUndo = $state<{
    kind: SidebarItem['kind'];
    path: string;
    state: SidebarItem['state'];
  } | null>(null);
  sidebarLabel(item: Pick<SidebarItem, 'kind' | 'path'>): string {
    if (item.kind === 'project') return this.projectName(item.path);
    const session = this.sessions.find(
      (entry) => this.sessionKey(entry.path) === this.sessionKey(item.path),
    );
    return (
      this.sidebarItem('session', item.path)?.name ||
      session?.name ||
      session?.preview ||
      item.path.split(/[\\/]/).at(-1) ||
      item.path
    );
  }
  /** 历史 deleted 状态兼容为归档，后续保存时统一写 archived。 */
  get archivedItems(): SidebarItem[] {
    return (this.settings.sidebarItems ?? []).filter((item) => !!item.state);
  }
  sidebarProject(item: Pick<SidebarItem, 'kind' | 'path'>): string {
    if (item.kind === 'project') return item.path;
    return (
      this.sessions.find(
        (entry) => this.sessionKey(entry.path) === this.sessionKey(item.path),
      )?.cwd ?? ''
    );
  }
  sidebarParent(
    item: Pick<SidebarItem, 'kind' | 'path'>,
  ): SidebarItem | undefined {
    if (item.kind !== 'session') return;
    const session = this.sessions.find(
      (entry) => this.sessionKey(entry.path) === this.sessionKey(item.path),
    );
    return session ? this.sidebarItem('project', session.cwd) : undefined;
  }
  async undoSidebar(): Promise<void> {
    const undo = this.sidebarUndo;
    if (!undo || this.sidebarSaving) return;
    await this.manageSidebar(undo.kind, undo.path, { state: undo.state });
    this.sidebarUndo = null;
    this.sidebarFeedback = '已撤销上一步操作';
  }
  sidebarItem(
    kind: SidebarItem['kind'],
    path: string,
  ): SidebarItem | undefined {
    const key =
      kind === 'project' ? this.projectKey(path) : this.sessionKey(path);
    return this.settings.sidebarItems?.find(
      (item) =>
        item.kind === kind &&
        (kind === 'project'
          ? this.projectKey(item.path)
          : this.sessionKey(item.path)) === key,
    );
  }
  projectName(path: string): string {
    return (
      this.sidebarItem('project', path)?.name ||
      path.split(/[\\/]/).filter(Boolean).at(-1) ||
      path
    );
  }
  get visibleSessions(): SessionSummary[] {
    return this.sessions
      .filter(
        (session) =>
          !this.sidebarItem('session', session.path)?.state &&
          !this.sidebarItem('project', session.cwd)?.state,
      )
      .map((session) => ({
        ...session,
        name: this.sidebarItem('session', session.path)?.name || session.name,
      }));
  }
  /** 归档只保存桌面元数据，原会话和源码均保留；恢复不丢失历史。 */
  async manageSidebar(
    kind: SidebarItem['kind'],
    path: string,
    change: { name?: string; state?: SidebarItem['state'] },
  ): Promise<void> {
    if (this.sidebarSaving) return;
    this.sidebarSaving = true;
    try {
      const previous = this.sidebarItem(kind, path);
      const item = { ...previous, kind, path, ...change };
      if (item.state === 'deleted') item.state = 'archived';
      if (item.name != null) {
        item.name = item.name.trim();
        if (!item.name || item.name.length > 200)
          throw new Error('名称须为 1 至 200 个字符。');
      }
      const sidebarItems = (this.settings.sidebarItems ?? [])
        .map((entry) => ({ ...entry }))
        .filter(
          (entry) =>
            entry !== previous &&
            !(
              entry.kind === kind &&
              (kind === 'project'
                ? this.projectKey(entry.path) === this.projectKey(path)
                : this.sessionKey(entry.path) === this.sessionKey(path))
            ),
        );
      sidebarItems.push(item);
      for (const entry of sidebarItems) {
        if (entry.state === 'deleted') entry.state = 'archived';
      }
      await this.api.save({ ...$state.snapshot(this.settings), sidebarItems });
      this.settings.sidebarItems = sidebarItems;
      if ('state' in change) {
        this.sidebarError = '';
        this.sidebarUndo = {
          kind,
          path,
          state: previous?.state ? 'archived' : undefined,
        };
        const label = this.sidebarLabel(item);
        const parent = this.sidebarParent(item);
        this.sidebarFeedback = item.state
          ? `已归档“${label}”`
          : `已恢复“${label}”${parent?.state ? '；所属项目仍被隐藏，恢复项目后将在侧栏显示' : ''}`;
      } else {
        this.notice = '名称已更新';
      }
    } finally {
      this.sidebarSaving = false;
    }
  }
  loadingSessions = $state(false);
  pinSaving = $state(false);
  get pinnedSessions(): SessionSummary[] {
    const sessions = new Map(
      this.visibleSessions.map((session) => [session.path, session]),
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
    return [...this.visibleSessions].sort((a, b) => this.compareSessions(a, b));
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
    for (const session of this.visibleSessions) {
      if (!session.cwd) continue;
      const key = this.projectKey(session.cwd);
      if (!groups.has(key))
        groups.set(key, { path: session.cwd, sessions: [] });
      groups.get(key)!.sessions.push(session);
    }
    for (const path of [this.project, ...this.settings.recentProjects]) {
      if (
        path &&
        !this.sidebarItem('project', path)?.state &&
        !groups.has(this.projectKey(path))
      )
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
  /** 上下文用量只用于展示；拉取失败保留上次结果，不影响会话主流程。 */
  stats = $state<SessionStats | null>(null);
  statsLoading = $state(false);
  private statsRequest = 0;
  private statsTask?: {
    runtime: string;
    session?: string;
    task: Promise<void>;
  };
  models = $state<Model[]>([]);
  levels = $state<string[]>([]);
  commands = $state<Command[]>([]);
  builtinRequest = $state<{ name: string; args: string } | null>(null);
  draft = $state('');
  images = $state<MessageImage[]>([]);
  recoveredImages = $state<{ text: string; images: MessageImage[] }[]>([]);
  /** 恢复时交换当前草稿，避免覆盖用户尚未发送的工作。 */
  restoreImages(index: number): void {
    const [draft] = this.recoveredImages.splice(index, 1);
    if (!draft) return;
    if (this.draft || this.images.length)
      this.recoveredImages.push({ text: this.draft, images: this.images });
    this.draft = draft.text;
    this.images = draft.images;
  }
  private imageDrafts = new Map<string, MessageImage[]>();
  /** 图片草稿沿用文本的项目/会话键，退出应用后不持久保存。 */
  private saveImageDraft(): void {
    this.imageDrafts.set(this.draftKey(), this.images);
  }
  private restoreImageDraft(): void {
    this.images = this.imageDrafts.get(this.draftKey()) ?? [];
  }
  newChatProject = $state<string | null>(null);
  // 首次发送创建真实会话会恢复 Pi 默认模型，显式选择需在创建后再次应用。
  private newChatModel: string | null = null;
  private newChatThinking: string | undefined;
  private clearDraftModel(): void {
    this.newChatModel = null;
    this.newChatThinking = undefined;
  }
  /**
   * 无保存偏好且模型仍在目录中时，返回当前显示的模型与强度。
   * 目录未就绪或模型已删除时不沿用，退回 Pi 默认值，避免把不可用模型带入发送。
   */
  private carriedModel(
    project: string,
  ): { key: string; thinking: string } | null {
    if (this.projectModel(project)) return null;
    const model = this.selectedModel;
    if (
      !model ||
      !this.models.some(
        (item) => item.provider === model.provider && item.id === model.id,
      )
    )
      return null;
    return {
      key: `${model.provider}/${model.id}`,
      thinking: this.selectedThinking,
    };
  }
  /** 目标项目已有偏好时交给项目偏好；否则沿用切换前显示的模型，避免首次发送后回落 Pi 默认值。 */
  private captureDraftModel(project: string): void {
    // 先读取当前显示值再清理旧草稿选择，否则会读到清空后的快照默认值。
    const carried = this.carriedModel(project);
    this.clearDraftModel();
    if (!carried) return;
    this.newChatModel = carried.key;
    this.newChatThinking = carried.thinking;
  }
  /** “+”只准备本地草稿，首次发送前不创建或切换 Pi 会话。 */
  prepareNewChat(project = this.project, preserveDraft = false): void {
    if (this.openingSession || this.submitting) return;
    this.drafts.set(this.draftKey(), this.draft);
    const text = this.draft;
    const images = this.images;
    this.saveImageDraft();
    // Windows 大小写与分隔符别名视为同一项目，不因路径写法差异重置草稿选择。
    const changed =
      this.newChatProject === null ||
      this.projectKey(this.newChatProject) !== this.projectKey(project);
    if (changed) this.captureDraftModel(project);
    this.newChatProject = project;
    this.draft = preserveDraft
      ? text
      : (this.drafts.get(this.draftKey()) ?? '');
    if (preserveDraft) this.images = images;
    else this.restoreImageDraft();
  }
  notice = $state('');
  modelConfigPending = $state(false);
  modelConfigApplying = $state(false);
  modelConfigStatus = $state('');
  private modelConfigRevision = 0;
  error = $state('');
  submitting = $state(false);
  /** 仅当前会话的消息被接受后恢复底部跟随；失败和本地命令不触发。 */
  sentMessageRevision = $state(0);
  loadingHistory = $state(false);
  openingSession = $state<{ path: string; title: string } | null>(null);
  private currentSessionTitle = $state('');
  /** 当前标题不依赖索引刷新是否暂时缺项；Pi 返回名称时仍以其为准。 */
  get sessionTitle(): string {
    if (this.openingSession) return this.openingSession.title;
    if (this.newChatProject !== null) return '新对话';
    const session = this.sessions.find(
      (item) =>
        this.sessionKey(item.path) ===
        this.sessionKey(this.snapshot.sessionFile ?? ''),
    );
    return (
      this.sidebarItem('session', this.snapshot.sessionFile ?? '')?.name ||
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
    return (
      this.sidebarItem('session', path)?.name ||
      session?.name ||
      session?.preview ||
      session?.timestamp ||
      ''
    );
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
  private historyRequest = 0;
  private searchGeneration = 0;
  private drafts = new Map<string, string>();
  private visible = new Set<string>();
  private accessed = new Map<string, number>();
  private accessSerial = 0;
  private submissionSerial = 0;
  /** 普通列表报告所有已挂载消息；已读正文不能被缓存淘汰后突然缩短。 */
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
    return this.newChatProject !== null
      ? `draft:${this.newChatProject}`
      : `${this.project}:${this.snapshot.sessionFile ?? 'new'}`;
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
      await this.connect(
        this.settings.recentProjects.find(
          (path) => !this.sidebarItem('project', path)?.state,
        ) ?? '',
      );
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
    this.saveImageDraft();
    const generation = ++this.generation;
    const modelRevision = this.modelConfigRevision;
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
      this.stats = null;
      this.currentSessionTitle = '';
      this.newChatProject = null;
      // 重连或切换项目后不得把旧草稿模型隐式应用到新会话。
      this.clearDraftModel();
      this.connection = 'ready';
      if (
        modelRevision === this.modelConfigRevision &&
        this.modelConfigPending
      ) {
        this.modelConfigPending = false;
        this.modelConfigStatus = '已从共享配置启动 Pi';
      }
      this.messages = [];
      this.toolViews = {};
      this.accessed.clear();
      this.visible.clear();
      this.run = connected.snapshot.isStreaming ? 'running' : 'idle';
      this.draft = this.drafts.get(this.draftKey()) ?? '';
      this.restoreImageDraft();
      this.settings.recentProjects = [
        this.project,
        ...this.settings.recentProjects.filter(
          (p) => this.projectKey(p) !== this.projectKey(this.project),
        ),
      ].slice(0, 20);
      if (!connected.verified)
        this.notice = `Pi ${connected.version} 未经本版验证，将按 RPC 能力连接。`;
      // 设置落盘与页面数据读取互不依赖，避免跨项目新建时逐步等待。
      await Promise.all([
        this.api.save($state.snapshot(this.settings)),
        this.refreshMetadata(),
        this.refreshHistory(),
        this.refreshSessions(),
        this.refreshStats(),
      ]);
      if (generation === this.generation) await this.applyProjectModel();
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
          // reset 是会话边界，按事件顺序清理；不能在批次末尾保留旧会话 widget。
          if (event.type === 'reset') {
            this.widgets = {};
            this.statuses = {};
            this.extensions = [];
          }
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
            await this.refreshStats();
            await this.refreshSessions();
          });
          if (
            this.run === 'idle' &&
            this.modelConfigPending &&
            !this.pendingSwitch?.waiting
          )
            void this.applyModelConfig();
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
  /**
   * 只读会话统计：上下文窗口估算与累计 tokens/费用。
   * 按 runtimeId 与 sessionFile 作废迟到响应，避免切会话后显示上一会话的数字；
   * 失败只保留既有值，用量是辅助信息，不应把连接错误推给用户。
   */
  refreshStats(): Promise<void> {
    if (this.connection !== 'ready' || !this.runtimeId)
      return Promise.resolve();
    const runtime = this.runtimeId;
    const session = this.snapshot.sessionFile;
    // 相同会话的并发刷新共用查询；切换后的新会话不等待旧查询。
    if (
      this.statsTask?.runtime === runtime &&
      this.statsTask.session === session
    )
      return this.statsTask.task;
    const task = this.fetchStats().finally(() => {
      if (this.statsTask?.task === task) this.statsTask = undefined;
    });
    this.statsTask = { runtime, session, task };
    return task;
  }
  private async fetchStats(): Promise<void> {
    const generation = this.generation;
    const runtime = this.runtimeId;
    const session = this.snapshot.sessionFile;
    const request = ++this.statsRequest;
    this.statsLoading = true;
    try {
      const stats = await this.action<SessionStats>({ type: 'session_stats' });
      if (
        generation !== this.generation ||
        runtime !== this.runtimeId ||
        request !== this.statsRequest ||
        session !== this.snapshot.sessionFile
      )
        return;
      this.stats = stats;
    } catch {
      // 忽略：统计失败不清空已展示的数字，也不覆盖主要错误提示。
    } finally {
      if (request === this.statsRequest) this.statsLoading = false;
    }
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
    // 新对话尚未提交时，后台仍是原会话；返回它只需退出本地草稿页。
    // 避免重新恢复同一会话触发扩展切换钩子，使返回操作被取消或挂起。
    if (
      this.newChatProject !== null &&
      this.connection === 'ready' &&
      this.snapshot.sessionFile &&
      this.sessionKey(path) === this.sessionKey(this.snapshot.sessionFile)
    ) {
      this.drafts.set(this.draftKey(), this.draft);
      this.saveImageDraft();
      this.newChatProject = null;
      this.clearDraftModel();
      this.draft = this.drafts.get(this.draftKey()) ?? '';
      this.restoreImageDraft();
      await this.applyProjectModel();
      return;
    }
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
  /** 新建期间屏蔽连接/reset 的中间状态，避免旧记录随 runtime/session key 反复挂载。 */
  async newSession(project = this.project): Promise<void> {
    if (this.openingSession) return;
    // 直接新建（如 /new）没有草稿页，仍需沿用新建前显示的模型与强度。
    // 草稿首次发送路径由 send() 负责，这里不重复捕获。
    const carried =
      this.newChatProject === null ? this.carriedModel(project) : null;
    this.openingSession = { path: '', title: '新对话' };
    try {
      if (this.connectionTask) await this.connectionTask;
      if (this.connection !== 'ready') await this.connect(project);
      else if (!(await this.switchSession(undefined, project))) return;
      if (carried && this.connection === 'ready')
        await this.applyCarriedModel(carried.key, carried.thinking);
    } finally {
      this.openingSession = null;
    }
  }
  /** 历史恢复由宿主投影与分页；首次只接收最后 50 条。 */
  async refreshHistory(
    before?: number,
    beforeInsert?: () => void,
  ): Promise<void> {
    if (before !== undefined && (this.loadingHistory || this.openingSession))
      return;
    const generation = this.generation;
    const session = this.snapshot.sessionFile;
    const request = ++this.historyRequest;
    const current = () =>
      generation === this.generation &&
      request === this.historyRequest &&
      session === this.snapshot.sessionFile;
    this.loadingHistory = true;
    try {
      const page = await this.action<HistoryPage>({ type: 'history', before });
      if (!current()) return;
      if (before !== undefined && page.hasMore && page.before >= before)
        throw new Error('历史游标未前进，请重试');
      // 空预览在插入前读取，避免先插入占位再异步撑高已读区域。
      await Promise.all(
        page.messages.map(async (message) => {
          if (
            !message.text &&
            message.contentRef &&
            message.role !== 'toolResult'
          ) {
            const content = await this.readContent(message.contentRef, 0);
            message.text = content.text;
            message.truncated = !content.done;
          }
        }),
      );
      if (!current()) return;
      const ids = new Set(
        before === undefined ? [] : this.messages.map((message) => message.id),
      );
      const incoming = page.messages.filter((message) => {
        if (ids.has(message.id)) return false;
        ids.add(message.id);
        return true;
      });
      if (before !== undefined && page.hasMore && !incoming.length)
        throw new Error('历史加载未返回更早消息，请重试');
      beforeInsert?.();
      this.messages =
        before === undefined ? incoming : [...incoming, ...this.messages];
      this.before = page.before;
      this.hasMore = page.hasMore;
    } catch (cause) {
      // 已取消会话的失败不能污染新会话，也不能在旧组件中弹出错误。
      if (current()) throw cause;
    } finally {
      if (request === this.historyRequest) this.loadingHistory = false;
    }
  }
  /** 提示词翻阅独立读取历史页，避免向正文插入消息而改变阅读位置。 */
  async promptHistory(before?: number): Promise<HistoryPage> {
    if (this.newChatProject !== null || this.openingSession)
      return { messages: [], before: 0, hasMore: false };
    const runtime = this.runtimeId;
    const session = this.snapshot.sessionFile;
    const page =
      before === undefined
        ? {
            messages: [...this.messages],
            before: this.before,
            hasMore: this.hasMore,
          }
        : await this.action<HistoryPage>({ type: 'history', before });
    if (runtime !== this.runtimeId || session !== this.snapshot.sessionFile)
      throw new Error('会话已切换，历史读取已取消');
    if (before !== undefined && page.hasMore && page.before >= before)
      throw new Error('历史游标未前进，请重试');
    return {
      ...page,
      messages: page.messages.filter(
        (message) =>
          message.role === 'user' && message.delivery?.state !== 'sending',
      ),
    };
  }
  /** 只有选中的提示词才读取全文；分块使用宿主偏移，不能用字符数推算。 */
  async promptText(message: Message): Promise<string> {
    if (!message.contentRef || (message.text && !message.truncated))
      return message.text;
    const chunks: string[] = [];
    let offset = 0;
    while (true) {
      const page = await this.readContent(message.contentRef, offset);
      chunks.push(page.text);
      if (page.done) return chunks.join('');
      if (page.next <= offset) throw new Error('正文读取未前进，请重试');
      offset = page.next;
    }
  }
  /** 发送接受前保留原草稿，超时绝不自动重发；用户消息由 Pi 权威事件插入。 */
  async send(mode?: 'steer' | 'followUp'): Promise<void> {
    if (
      (!this.draft.trim() && !this.images.length) ||
      this.submitting ||
      this.openingSession ||
      this.connection !== 'ready'
    )
      return;
    const text = this.draft;
    const images = this.images;
    if (images.length && text.trimStart().startsWith('/'))
      throw new Error('图片不能与斜杠命令一起发送，请修改文字或移除图片。');
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
    if (this.newChatProject !== null) {
      // 创建真实会话也会恢复默认强度，在创建前保留输入区的最终选择。
      // 已捕获的显示值优先，仅在缺省时补当前快照强度。
      if (this.newChatModel && this.newChatThinking === undefined)
        this.newChatThinking = this.snapshot.thinkingLevel ?? 'off';
      const project = this.newChatProject;
      try {
        await this.newSession(project);
      } finally {
        // 创建失败或被扩展取消时保留项目选择与首条消息，不能发进原会话。
        this.draft = text;
        this.images = images;
      }
      if (this.newChatProject !== null || this.connection !== 'ready') return;
      this.draft = text;
    }
    if (this.newChatModel) {
      // 项目偏好优先于草稿沿用的选择；应用失败时保留选择，重试不再创建会话。
      await this.applyCarriedModel(this.newChatModel, this.newChatThinking);
      this.clearDraftModel();
    }
    if (this.projectModel(this.project) && this.run === 'idle')
      await this.applyProjectModel();
    if (
      images.length &&
      this.snapshot.model?.input &&
      !this.snapshot.model.input.includes('image')
    )
      throw new Error('当前模型不支持图片输入，请切换到支持图片的模型。');
    const sessionFile = this.snapshot.sessionFile;
    const generation = this.generation;
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
          images,
          contentRef: null,
          status: 'done',
          name: null,
          delivery: { mode: delivery, state: 'sending' },
        },
      ];
    }
    // 普通反馈在下一次有效提交时结束；停止和压缩状态不能随发送清除。
    if (this.run !== 'aborting' && this.run !== 'compacting') this.notice = '';
    this.submitting = true;
    try {
      await this.action({
        type: 'prompt',
        message: text,
        mode: delivery,
        ...(images.length
          ? {
              images: images.map((image) => ({
                type: 'image' as const,
                data: image.data!,
                mimeType: image.mimeType,
              })),
            }
          : {}),
      });
      // 迟到的提交结果不能把新会话的阅读位置拉到底部。
      if (
        generation === this.generation &&
        sessionFile === this.snapshot.sessionFile &&
        this.newChatProject === null &&
        !this.openingSession
      )
        this.sentMessageRevision++;
      if (sessionFile) this.sentAt[this.sessionKey(sessionFile)] = sentAt;
      const pending = this.messages.find((message) => message.id === pendingId);
      if (pending?.delivery) pending.delivery.state = 'queued';
      if (this.draft === text) this.draft = '';
      const sent = new Set(images.map((image) => image.id));
      this.images = this.images.filter((image) => !sent.has(image.id));
      if (delivery && this.run !== 'aborting' && this.run !== 'compacting')
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
      this.refreshStats(),
    ]);
    await this.applyProjectModel();
  }
  /** 计划命令直接走 RPC，保留当前草稿和图片；只接受空闲状态下的显式操作。 */
  async planAction(action: 'continue' | 'stop'): Promise<void> {
    if (
      this.connection !== 'ready' ||
      this.openingSession ||
      this.newChatProject !== null ||
      this.run !== 'idle' ||
      this.submitting
    )
      return;
    this.submitting = true;
    try {
      await this.action({ type: 'prompt', message: `/todos ${action}` });
    } finally {
      this.submitting = false;
    }
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
      const pendingMessages = this.messages.filter(
        (message) => message.delivery,
      );
      const cleared = await this.api.action<{
        steering?: string[];
        followUp?: string[];
      }>(runtimeId, { type: 'stop' });
      if (generation !== this.generation) return;
      // clear_queue 只返回文本，按模式及提交顺序消费，避免同文的纯文字消息抢走附件。
      for (const [mode, texts] of [
        ['steer', cleared.steering ?? []],
        ['followUp', cleared.followUp ?? []],
      ] as const) {
        for (const text of texts) {
          const index = pendingMessages.findIndex(
            (message) =>
              message.text === text && message.delivery?.mode === mode,
          );
          const message =
            index >= 0 ? pendingMessages.splice(index, 1)[0] : undefined;
          if (message?.images?.length)
            this.recoveredImages.push({ text, images: message.images });
          else this.recovered.push(text);
        }
      }
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
  /** 新建/切换只在成功且未被扩展取消后提交 UI 状态；返回是否真正切换。 */
  async switchSession(path?: string, project = this.project): Promise<boolean> {
    if (!this.project) return false;
    const title = path
      ? this.sessionLabel(path) || this.openingSession?.title || ''
      : '';
    this.drafts.set(this.draftKey(), this.draft);
    this.saveImageDraft();
    const result = await this.action<{ cancelled: boolean }>(
      path
        ? { type: 'switch_session', path }
        : this.projectKey(project) !== this.projectKey(this.project)
          ? { type: 'new_project_session', project }
          : { type: 'new_session' },
    );
    if (result.cancelled) {
      this.notice = '切换已被 Pi 扩展取消';
      return false;
    }
    ++this.historyRequest;
    this.loadingHistory = false;
    this.stats = null;
    this.currentSessionTitle = title;
    if (path) this.clearDraftModel();
    // 仅创建成功才消费本地草稿；打开历史、创建取消或失败均保留它。
    if (!path && this.newChatProject !== null) {
      this.drafts.delete(this.draftKey());
      this.imageDrafts.delete(this.draftKey());
    }
    this.newChatProject = null;
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
      this.refreshStats(),
    ]);
    this.draft = this.drafts.get(this.draftKey()) ?? '';
    this.restoreImageDraft();
    await this.applyProjectModel();
    if (this.projectKey(previousProject) !== this.projectKey(this.project)) {
      this.settings.recentProjects = [
        this.project,
        ...this.settings.recentProjects.filter(
          (item) => this.projectKey(item) !== this.projectKey(this.project),
        ),
      ].slice(0, 20);
      await this.api.save($state.snapshot(this.settings));
    }
    return true;
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
    this.stats = null;
  }
  /** 重命名只针对已打开会话，并由 Pi 负责写入。 */
  async rename(name: string): Promise<void> {
    if (!name.trim()) return;
    await this.action({ type: 'rename', name: name.trim() });
    this.currentSessionTitle = name.trim();
    await this.syncState();
    await this.refreshSessions();
  }
  /** 项目偏好按规范化目录隔离；新对话草稿以其目标目录为准。 */
  private projectModel(project = this.newChatProject ?? this.project) {
    return this.settings.projectModels?.find(
      (item) => this.projectKey(item.project) === this.projectKey(project),
    );
  }
  /** 目录中精确匹配；偏好引用的模型可能已从配置移除，按原键展示以便提示。 */
  private modelByKey(provider: string, id: string): Model {
    return (
      this.models.find(
        (model) => model.provider === provider && model.id === id,
      ) ?? { provider, id, name: id }
    );
  }
  /** 草稿选择以 key 保存，目录刷新后仍可显示；未命中时按首个斜杠拆分。 */
  private modelByKeyString(key: string): Model | undefined {
    const exact = this.models.find(
      (model) => `${model.provider}/${model.id}` === key,
    );
    if (exact) return exact;
    const slash = key.indexOf('/');
    if (slash <= 0) return undefined;
    return this.modelByKey(key.slice(0, slash), key.slice(slash + 1));
  }
  /**
   * 跨项目本地草稿显示其项目偏好，后台会话仍在原项目。
   * 无偏好时优先显示草稿沿用/显式选择，否则显示当前连接会话的模型。
   */
  get selectedModel(): Model | undefined {
    const preference = this.projectModel();
    if (preference)
      return this.modelByKey(preference.provider, preference.model);
    if (this.newChatProject !== null && this.newChatModel)
      return this.modelByKeyString(this.newChatModel);
    return this.snapshot.model;
  }
  get selectedThinking(): string {
    return (
      this.projectModel()?.thinkingLevel ??
      (this.newChatProject !== null && this.newChatThinking !== undefined
        ? this.newChatThinking
        : (this.snapshot.thinkingLevel ?? 'off'))
    );
  }
  private async rememberProjectModel(project: string): Promise<void> {
    const model = this.snapshot.model;
    if (!project || !model) return;
    const preference = {
      project,
      provider: model.provider,
      model: model.id,
      thinkingLevel: this.snapshot.thinkingLevel ?? 'off',
    };
    const projectModels = [
      ...(this.settings.projectModels ?? []).filter(
        (item) => this.projectKey(item.project) !== this.projectKey(project),
      ),
      preference,
    ];
    // 先写入内存保留已确认的选择；磁盘失败明确提示，用户可重试保存。
    this.settings.projectModels = projectModels;
    try {
      await this.api.save($state.snapshot(this.settings));
    } catch (cause) {
      throw new Error(
        `当前会话已应用，但项目设置保存失败：${errorMessage(cause)}`,
      );
    }
  }
  /** 恢复项目统一值；旧会话自身记录不能覆盖项目选择，发送前也会重新核对。 */
  private async applyProjectModel(): Promise<void> {
    const preference = this.projectModel(this.project);
    if (!preference || this.run !== 'idle') return;
    const key = `${preference.provider}/${preference.model}`;
    if (
      this.snapshot.model?.provider === preference.provider &&
      this.snapshot.model?.id === preference.model &&
      this.snapshot.thinkingLevel === preference.thinkingLevel
    )
      return;
    await this.applyModel(key, preference.thinkingLevel);
  }
  /** 模型与强度确认后统一保存到工作项目，不修改其他项目。 */
  async setModel(key: string): Promise<void> {
    const model = this.models.find((m) => `${m.provider}/${m.id}` === key);
    if (!model) return;
    const project = this.newChatProject ?? this.project;
    const runtime = this.runtimeId;
    const session = this.snapshot.sessionFile;
    await this.applyModel(key, this.projectModel(project)?.thinkingLevel);
    if (runtime !== this.runtimeId || session !== this.snapshot.sessionFile)
      return;
    if (this.newChatProject !== null) this.newChatModel = key;
    await this.rememberProjectModel(project);
  }
  /** 所有强度入口共用此方法，确保项目模型与强度作为一组持久化。 */
  async setThinking(level: string): Promise<void> {
    const project = this.newChatProject ?? this.project;
    const runtime = this.runtimeId;
    const session = this.snapshot.sessionFile;
    const preference = this.projectModel(project);
    if (
      preference &&
      (this.snapshot.model?.provider !== preference.provider ||
        this.snapshot.model?.id !== preference.model)
    ) {
      await this.applyModel(
        `${preference.provider}/${preference.model}`,
        preference.thinkingLevel,
      );
      if (runtime !== this.runtimeId || session !== this.snapshot.sessionFile)
        return;
    }
    try {
      await this.action({ type: 'set_thinking', level });
    } catch (cause) {
      // 桥接可能在能力更新后失败，以 Pi 状态恢复控件；不保存失败的项目偏好。
      await this.syncState();
      throw cause;
    }
    await this.syncState();
    if (runtime !== this.runtimeId || session !== this.snapshot.sessionFile)
      return;
    if (project && this.snapshot.model)
      await this.rememberProjectModel(project);
  }
  /**
   * 新建会话后再次应用草稿沿用的模型；目标项目已有偏好时以偏好为准。
   * 与 Pi 快照一致时不重复 RPC，失败向上抛出以保留草稿且不发送。
   */
  private async applyCarriedModel(
    key: string | null,
    thinking: string | undefined,
  ): Promise<void> {
    if (!key || this.projectModel(this.project)) return;
    const slash = key.indexOf('/');
    const provider = slash > 0 ? key.slice(0, slash) : '';
    const id = slash > 0 ? key.slice(slash + 1) : key;
    if (
      this.snapshot.model?.provider === provider &&
      this.snapshot.model?.id === id &&
      (thinking === undefined || this.snapshot.thinkingLevel === thinking)
    )
      return;
    await this.applyModel(key, thinking);
  }
  private async applyModel(
    key: string,
    thinkingLevel = this.snapshot.thinkingLevel ?? 'off',
  ): Promise<void> {
    const runtime = this.runtimeId;
    const session = this.snapshot.sessionFile;
    const model = this.models.find((m) => `${m.provider}/${m.id}` === key);
    if (!model) throw new Error('所选模型已不可用，请重新选择模型。');
    await this.action({
      type: 'set_model',
      provider: model.provider,
      model: model.id,
    });
    await this.syncState();
    if (runtime !== this.runtimeId || session !== this.snapshot.sessionFile)
      return;
    // 单独查询新模型支持等级，查询失败时不能依赖旧目录判断或继续发送。
    const { levels = [] } = await this.action<{ levels: string[] }>({
      type: 'thinking_levels',
    });
    if (runtime !== this.runtimeId || session !== this.snapshot.sessionFile)
      return;
    this.levels = levels;
    if (this.snapshot.thinkingLevel !== thinkingLevel) {
      if (levels.includes(thinkingLevel)) {
        try {
          await this.action({ type: 'set_thinking', level: thinkingLevel });
        } catch (cause) {
          await this.syncState();
          throw new Error(
            `模型已切换，但保留思考强度失败：${errorMessage(cause)}`,
          );
        }
        await this.syncState();
      }
      if (runtime !== this.runtimeId || session !== this.snapshot.sessionFile)
        return;
      if (this.snapshot.thinkingLevel !== thinkingLevel)
        this.notice = `当前模型无法使用思考强度 ${thinkingLevel}，已采用 ${this.snapshot.thinkingLevel ?? 'off'}。`;
    }
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
  /** 共享配置 IO 与会话独立；不把凭据放入通用 Settings。 */
  loadModelConfig() {
    return this.api.modelConfig();
  }
  discoverModels(provider: ProviderConfig) {
    return this.api.discoverModels(provider);
  }
  async saveModelConfig(config: ModelSettings): Promise<ModelSettings> {
    const saved = await this.api.saveModelConfig(config);
    this.modelConfigRevision++;
    this.modelConfigPending = true;
    this.modelConfigStatus =
      this.run !== 'idle' ? '已保存，等待任务结束后应用' : '已保存';
    await this.applyModelConfig();
    return saved;
  }
  /** 刷新只在空闲时执行，失败保留待应用状态；迟到结果不能覆盖新的运行实例。 */
  async applyModelConfig(): Promise<void> {
    if (!this.modelConfigPending || this.modelConfigApplying) return;
    if (this.connection !== 'ready') {
      this.modelConfigStatus = '已保存，下次连接生效';
      return;
    }
    if (this.run !== 'idle') return;
    const runtime = this.runtimeId;
    const revision = this.modelConfigRevision;
    this.modelConfigApplying = true;
    this.modelConfigStatus = '已保存，正在应用…';
    try {
      await this.api.action(runtime, { type: 'refresh_models' });
      if (runtime !== this.runtimeId || revision !== this.modelConfigRevision)
        return;
      await this.syncState();
      await this.refreshMetadata();
      await this.applyProjectModel();
      this.modelConfigPending = false;
      this.modelConfigStatus =
        '已保存并应用；默认值用于后续新会话，必要时重新连接 Pi';
    } catch (error) {
      if (runtime === this.runtimeId && revision === this.modelConfigRevision)
        this.modelConfigStatus = `已保存，应用失败：${errorMessage(error)}。可重试或重新连接 Pi。`;
    } finally {
      this.modelConfigApplying = false;
    }
  }
  /** 配置更新原子持久化，运行时配置需重新连接才生效。 */
  async saveSettings(settings: Settings): Promise<void> {
    // 设置表单可能早于项目选择打开，保留运行期间更新的项目统一值。
    const merged = {
      ...settings,
      projectModels: $state.snapshot(this.settings.projectModels),
    };
    await this.api.save(merged);
    this.settings = merged;
    await this.refreshSessions();
  }
  /** 连接诊断只返回版本与路径，不读凭据。 */
  detect(settings: Settings) {
    return this.api.detect(settings);
  }
}
