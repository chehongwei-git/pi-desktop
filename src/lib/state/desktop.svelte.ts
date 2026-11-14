/** 应用门面：组件只调用用户意图；集中连接状态、草稿、事件确认与切换事务。 */
import { bridge, errorMessage, type Bridge } from '../client';
import { draftText, type DraftPart } from '../draft-parts';
import {
  attachmentImages,
  composePrompt,
  hasDraft,
  imageAttachment,
  snapshotDraft,
  type DraftAttachment,
  type DraftSnapshot,
} from '../attachments';
import { textRanges, localTextParts } from '../text-presentation';
import { parseBuiltin } from '../commands';
import { sessionPreview } from '../session-preview';
import {
  thinkingLevels,
  type ModelSettings,
  type ProviderConfig,
} from '../model-config';
import { terminalText } from '../terminal-text';
import {
  editEntryId,
  restoreMessageDraft,
  type MessageEdit,
} from '../message-edit';
import { completedPlan, planSteps } from '../plan-steps';
import { SessionContent } from './session-content';
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

/** 工作区只负责导航与共享配置，单会话保留既有 RPC 状态机。 */
export interface SessionNavigation {
  open(project: string, path: string): Promise<void>;
  draft(project: string, preserve: boolean): void;
  connect(project: string): Promise<void>;
  ensure(): Promise<void>;
  changed(): void;
  stopForArchive(path: string): Promise<void>;
  archived(path: string): void;
}
export class Desktop {
  /** 桌面身份早于 Pi 文件存在，排队转历史及恢复时继续沿用。 */
  desktopId = $state(crypto.randomUUID() as string);
  createdAt = $state(new Date().toISOString());
  lastSentAt = $state('');
  /** 索引尚未收录时保留首条输入摘要，任务结束后侧栏标题仍然可用。 */
  sidebarPreview = $state('');
  restored = $state(false);
  navigation?: SessionNavigation;
  task = $state<import('../types').TaskActivity | null>(null);
  taskInput: DraftSnapshot | null = null;
  /** 本地队列快照与 Pi 返回的正文对应；停止恢复不反向解析路径文本。 */
  private queuedDrafts: {
    id: string;
    text: string;
    mode: 'steer' | 'followUp';
    draft: DraftSnapshot;
  }[] = [];
  scrollState: {
    top: number;
    follow: boolean;
    changeId?: string;
    textTarget?: { messageId: string; partId: string; top: number };
  } = {
    top: 0,
    follow: true,
  };
  private loadedHistoryCount = 0;
  /** 内容与进程生命周期分离；空历史也属于已加载的缓存。 */
  historyCached = $state(false);
  restoring = $state(false);
  connectionPhase = $state('');
  private phaseTimer?: ReturnType<typeof setTimeout>;
  private connectionRecovery = false;
  /** 短操作不闪现连接提示，恢复故障和正常加载使用不同文案。 */
  setConnectionPhase(label: string): void {
    clearTimeout(this.phaseTimer);
    this.connectionPhase = '';
    if (label)
      this.phaseTimer = setTimeout(() => {
        this.connectionPhase = label;
      }, 200);
  }
  waitingToSend = $state(false);
  private content = new SessionContent();
  private suppressTranscript = false;
  private contentWaiters = new Set<{
    resolve(): void;
    reject(error: Error): void;
  }>();
  /** 视图在历史原子替换前保存当下锚点，返回提交后的恢复回调。 */
  beforeHistoryCommit?: () => () => void;

  /** 连接与历史引用均就绪后才唤醒读取；失败一次性通知等待者，避免悬挂请求。 */
  finishRestore(): void {
    this.restoring = false;
    this.setConnectionPhase('');
    for (const waiter of this.contentWaiters) {
      if (this.connection === 'ready') waiter.resolve();
      else waiter.reject(new Error(this.error || '连接恢复失败，请重试'));
    }
    this.contentWaiters.clear();
    if (this.connection === 'ready') void this.drain();
  }

  private async contentReady(): Promise<void> {
    if (!this.restoring && this.connection === 'ready') return;
    if (!this.restoring && this.connection === 'failed')
      throw new Error(this.error || '连接恢复失败，请重试');
    // 隐藏视图只等待激活，不因图片或详情挂载自行启动进程。
    await new Promise<void>((resolve, reject) =>
      this.contentWaiters.add({ resolve, reject }),
    );
  }

  /** 只用于工作区确认未挂载且不在执行的会话；保留草稿与阅读恢复信息。 */
  evictContent(): void {
    this.loadedHistoryCount = Math.max(
      this.loadedHistoryCount,
      this.messages.length,
    );
    this.historyCached = false;
    this.messages = [];
    this.content.clear();
    this.visible.clear();
    this.accessed.clear();
    for (const waiter of this.contentWaiters)
      waiter.reject(new Error('会话缓存已释放'));
    this.contentWaiters.clear();
  }
  /** 只标记尚未查看的执行结果，不因后台输出抢焦点。 */
  unread = $state(false);
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
  /** 宿主已接受、Pi 尚未产出权威用户消息时的首条本地展示。 */
  initialPending = $state<Message | null>(null);
  get transcriptMessages(): Message[] {
    return this.initialPending && !this.messages.some((m) => m.role === 'user')
      ? [this.initialPending, ...this.messages]
      : this.messages;
  }
  /** 轮次变更独立于历史分页；会话恢复后按真实身份重新读取。 */
  turnChanges = $state<import('../types').TurnChanges[]>([]);
  changesError = $state('');
  private changesRequest = 0;
  async refreshChanges(): Promise<void> {
    const request = ++this.changesRequest;
    const runtime = this.runtimeId;
    try {
      const turns = await this.action<import('../types').TurnChanges[]>({
        type: 'changes',
      });
      if (request !== this.changesRequest || runtime !== this.runtimeId) return;
      this.turnChanges = turns.map((turn) => ({
        ...turn,
        files: turn.files.map((file) => {
          const message = this.content.bind(
            {
              id: `turn:${turn.id}:${file.path}`,
              role: 'toolResult',
              text: '',
              thinking: '',
              status: 'done',
              name: null,
              contentRef: file.contentRef,
            },
            runtime,
          );
          return { ...file, contentRef: message.contentRef! };
        }),
      }));
      this.changesError = '';
    } catch (error) {
      if (request === this.changesRequest && runtime === this.runtimeId)
        this.changesError = errorMessage(error);
    }
  }
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
      if (kind === 'session' && item.state === 'archived' && change.state) {
        // 归档对象可能在后台运行，须按路径停止所属实例，不能停止当前视图。
        if (this.navigation) await this.navigation.stopForArchive(path);
        else if (
          this.snapshot.sessionFile &&
          this.sessionKey(this.snapshot.sessionFile) ===
            this.sessionKey(path) &&
          (this.run !== 'idle' || this.extensions.length)
        ) {
          await this.stop();
          if (this.run !== 'idle' || this.extensions.length)
            throw new Error('会话尚未停止，请等待停止完成后重试归档。');
        }
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
      if (kind === 'session' && item.state === 'archived' && change.state)
        this.navigation?.archived(path);
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
    projectPaths = this.projects.map((project) => project.path),
  ): Promise<void> {
    if (this.projectOrderSaving) return;
    const order = [...projectPaths];
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
    const normalized =
      path
        .replace(/\\/g, '/')
        .replace(/^\/\/\?\//, '')
        .replace(/\/$/, '') || (path ? '/' : '');
    const key = normalized.replace(/^unc\//i, '//');
    return /^[a-z]:(?:\/|$)/i.test(key) || key.startsWith('//')
      ? key.toLowerCase()
      : key;
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
  private draftValue = $state('');
  private draftRevision = 0;
  get draft(): string {
    return this.draftValue;
  }
  set draft(value: string) {
    if (value !== this.draftValue) ++this.draftRevision;
    this.draftValue = value;
  }
  private structuredDrafts = $state<Record<string, DraftPart[]>>({});
  /** 片段与项目/会话草稿同域；外部文字替换不猜测旧卡片的位置。 */
  get draftParts(): DraftPart[] {
    const parts = this.structuredDrafts[this.draftKey()];
    return parts && draftText(parts) === this.draft ? parts : [];
  }
  set draftParts(parts: DraftPart[]) {
    const previous = this.structuredDrafts[this.draftKey()];
    // 编辑器重挂载会复制片段；只有内容或折叠边界改变才算用户的新版本。
    const changed = previous
      ? previous.length !== parts.length ||
        previous.some((part, index) => {
          const next = parts[index];
          return (
            !next ||
            part.kind !== next.kind ||
            part.text !== next.text ||
            (part.kind === 'paste' &&
              next.kind === 'paste' &&
              part.id !== next.id)
          );
        })
      : parts.some((part) => part.kind === 'paste');
    if (changed) ++this.draftRevision;
    this.structuredDrafts[this.draftKey()] = parts;
  }
  attachments = $state<DraftAttachment[]>([]);
  /** 保留图片投影供模型能力与既有调用使用，附件只有一个可变数据源。 */
  get images(): MessageImage[] {
    return attachmentImages(this.attachments);
  }
  set images(images: MessageImage[]) {
    const available = this.attachments.filter((item) => item.kind === 'image');
    const next = images.map((image) => {
      const index = available.findIndex((item) => item.image === image);
      return index >= 0
        ? available.splice(index, 1)[0]
        : imageAttachment(image);
    });
    this.attachments = [
      ...this.attachments.filter((item) => item.kind === 'path'),
      ...next,
    ];
  }
  recoveredDrafts = $state<DraftSnapshot[]>([]);
  draftSnapshot(): DraftSnapshot {
    return snapshotDraft(this.draft, this.draftParts, this.attachments);
  }
  /** 恢复时交换当前草稿，避免覆盖用户尚未发送的工作。 */
  restoreDraft(index: number): void {
    const [draft] = this.recoveredDrafts.splice(index, 1);
    if (!draft) return;
    const current = this.draftSnapshot();
    if (hasDraft(current)) this.recoveredDrafts.push(current);
    this.draft = draft.text;
    this.draftParts = draft.parts;
    this.attachments = draft.attachments;
  }
  private attachmentDrafts = new Map<string, DraftAttachment[]>();
  /** 全部附件沿用文本的项目/会话键；持久化层只保存路径引用。 */
  private saveAttachmentDraft(): void {
    this.attachmentDrafts.set(this.draftKey(), this.attachments);
  }
  private restoreAttachmentDraft(): void {
    this.attachments = this.attachmentDrafts.get(this.draftKey()) ?? [];
  }
  newChatProject = $state<string | null>(null);
  // 首次发送创建真实会话会恢复 Pi 默认模型，显式选择需在创建后再次应用。
  private newChatModel = $state<string | null>(null);
  private newChatThinking = $state<string | undefined>();
  // 运行中只暂存选择；任务结束和工具续答均不会自动应用。
  private pendingSelection = $state<{
    session?: string;
    key: string;
    thinking: string;
  } | null>(null);
  get hasPendingModel(): boolean {
    return (
      this.newChatProject === null &&
      this.pendingSelection !== null &&
      this.pendingSelection.session === this.snapshot.sessionFile
    );
  }
  private stageModel(key: string, thinking: string): void {
    const model = this.modelByKeyString(key);
    if (!model) throw new Error('所选模型已不可用，请重新选择模型。');
    this.pendingSelection = {
      session: this.snapshot.sessionFile,
      key,
      thinking:
        thinking !== 'off' && model.thinkingLevelMap?.[thinking] === null
          ? 'off'
          : thinking,
    };
  }
  /** 只有主动发送才提交暂存配置，失败保留草稿与选择，不自动重发。 */
  private async applyPendingSelection(): Promise<void> {
    if (!this.hasPendingModel) return;
    const selection = this.pendingSelection!;
    const runtime = this.runtimeId;
    this.submitting = true;
    try {
      await this.applyModel(selection.key, selection.thinking);
      if (
        runtime !== this.runtimeId ||
        selection.session !== this.snapshot.sessionFile
      )
        throw new Error('会话已切换，请返回原会话后重新发送。');
      if (!this.navigation) await this.rememberProjectModel(this.project);
      if (this.pendingSelection === selection) this.pendingSelection = null;
    } finally {
      this.submitting = false;
    }
  }
  /** 工作区新建入口显式继承显示值，避免项目旧偏好覆盖来源会话的选择。 */
  initializeDraftModel(model: Model | undefined, thinking: string): void {
    this.newChatModel = model ? `${model.provider}/${model.id}` : null;
    this.newChatThinking = thinking;
  }
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
    if (this.navigation) {
      this.navigation.draft(project, preserveDraft);
      return;
    }
    if (this.openingSession || this.submitting) return;
    this.drafts.set(this.draftKey(), this.draft);
    const text = this.draft;
    const parts = this.draftParts;
    const attachments = this.attachments;
    this.saveAttachmentDraft();
    // Windows 大小写与分隔符别名视为同一项目，不因路径写法差异重置草稿选择。
    const changed =
      this.newChatProject === null ||
      this.projectKey(this.newChatProject) !== this.projectKey(project);
    if (changed) this.captureDraftModel(project);
    this.newChatProject = project;
    this.draft = preserveDraft
      ? text
      : (this.drafts.get(this.draftKey()) ?? '');
    if (preserveDraft) {
      this.attachments = attachments;
      this.draftParts = parts;
    } else this.restoreAttachmentDraft();
  }
  /** 编辑快照归属会话实例，切换视图不覆盖底部草稿。 */
  messageEdit = $state<MessageEdit | null>(null);
  async editMessage(message: Message): Promise<void> {
    if (
      this.messageEdit ||
      this.submitting ||
      message.role !== 'user' ||
      message.delivery ||
      message.id.startsWith('accepted-')
    )
      return;
    const edit: MessageEdit = {
      message,
      draft: { text: '', parts: [], attachments: [] },
      session: this.snapshot.sessionFile,
      loading: true,
      busy: false,
      error: '',
    };
    this.messageEdit = edit;
    const current = () =>
      this.messageEdit?.message.id === message.id &&
      this.snapshot.sessionFile === edit.session;
    try {
      const draft = await restoreMessageDraft(
        message,
        (id, offset) => this.readContent(id, offset),
        current,
      );
      if (current()) this.messageEdit!.draft = draft;
    } catch (cause) {
      if (current()) this.messageEdit!.error = errorMessage(cause);
    } finally {
      if (current()) this.messageEdit!.loading = false;
    }
  }
  /** 分支与发送分阶段记录；已建分支的重试绝不再次 fork，未知结果禁止盲重发。 */
  async resendMessage(): Promise<void> {
    const edit = this.messageEdit;
    if (!edit || edit.busy || edit.loading || edit.uncertain) return;
    if (
      this.run !== 'idle' ||
      this.submitting ||
      this.restoring ||
      this.task?.state === 'queued'
    ) {
      edit.error = '请等待当前任务结束后发送。';
      return;
    }
    edit.error = '';
    edit.busy = true;
    this.submitting = true;
    let mutating = false;
    const runtime = this.runtimeId;
    try {
      if (this.connection !== 'ready')
        throw new Error('请先重新连接 Pi，再发送。');
      if (this.snapshot.sessionFile !== (edit.branch ?? edit.session))
        throw new Error('会话已切换，请取消后重新编辑。');
      const { text, parts, images, files, fileStart } = composePrompt(
        edit.draft,
      );
      if (!text.trim() && !images.length)
        throw new Error('请输入消息或保留附件。');
      if (text.trimStart().startsWith('/'))
        throw new Error('编辑重发不执行斜杠命令，请使用底部输入框。');
      await this.applyPendingSelection();
      const model = this.snapshot.model;
      const thinking = this.snapshot.thinkingLevel;
      if (
        images.length &&
        this.snapshot.model?.input &&
        !this.snapshot.model.input.includes('image')
      )
        throw new Error('当前模型不支持图片输入，请切换模型。');
      if (!edit.branch) {
        const tree = await this.action<{
          nodes: { id: string; parentId: string | null; label: string }[];
          leafId: string | null;
        }>({ type: 'session_tree' });
        const entryId = editEntryId(
          edit.message,
          this.messages,
          tree.nodes,
          tree.leafId,
        );
        mutating = true;
        const result = await this.action<{ cancelled?: boolean }>({
          type: 'fork',
          entryId,
        });
        if (result.cancelled) {
          mutating = false;
          throw new Error('编辑重发已被 Pi 扩展取消。');
        }
        await this.syncState();
        edit.branch = this.snapshot.sessionFile;
        if (!edit.branch || edit.branch === edit.session)
          throw new Error('无法确认新分支，请检查会话状态。');
        mutating = false;
        this.navigation?.changed();
      }
      // fork 重建 Pi 运行时可能恢复历史模型；本次主动发送沿用界面确认的选择。
      if (
        model &&
        (this.snapshot.model?.id !== model.id ||
          this.snapshot.model?.provider !== model.provider ||
          this.snapshot.thinkingLevel !== thinking)
      ) {
        await this.action({
          type: 'set_model',
          provider: model.provider,
          model: model.id,
          thinking,
        });
      }
      mutating = true;
      await this.action({
        type: 'prompt',
        message: text,
        textParts: textRanges(parts, text, files, fileStart),
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
      mutating = false;
      // 接受后才替换旧展示；刷新失败也不能把同一消息再发一次。
      this.messageEdit = null;
      this.sentMessageRevision++;
      this.lastSentAt = new Date().toISOString();
      await this.refreshCommandSession(false);
      this.navigation?.changed();
    } catch (cause) {
      if (this.messageEdit === edit) {
        edit.error = errorMessage(cause);
        const rejected =
          typeof cause === 'object' &&
          cause !== null &&
          'code' in cause &&
          cause.code === 'PI_COMMAND';
        if (mutating && !rejected) {
          edit.uncertain = true;
          edit.error += ' 操作可能已执行，请检查会话后再操作，不要重复发送。';
        }
      } else this.error = errorMessage(cause);
    } finally {
      edit.busy = false;
      this.submitting = false;
      if (runtime !== this.runtimeId && this.messageEdit === edit)
        edit.uncertain = true;
    }
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
    return this.projectKey(path);
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
  /** 只隐藏已提交前完成的那份计划；原始扩展数据仍保留供重连和新计划使用。 */
  private hiddenPlan = $state('');
  private planRevision = 0;
  get visibleWidgets(): Record<string, string[]> {
    const lines = this.widgets['plan-todos'] ?? [];
    return this.hiddenPlan && completedPlan(lines) === this.hiddenPlan
      ? { ...this.widgets, 'plan-todos': [] }
      : this.widgets;
  }
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
  private initialSubmission?: {
    id: string;
    fingerprint: string;
    generation?: number;
  };
  /** 普通列表报告所有已挂载消息；已读正文不能被缓存淘汰后突然缩短。 */
  pinVisible(ids: string[]): void {
    this.visible = new Set(ids);
    for (const id of ids) this.accessed.set(id, ++this.accessSerial);
  }
  private respondingExtensions = new Set<string>();
  private extensionTimers = new Map<string, ReturnType<typeof setTimeout>>();
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
    const submission =
      this.navigation &&
      (action.type === 'prompt' ||
        action.type === 'compact' ||
        (action.type === 'navigate_tree' && action.summarize))
        ? `${this.runtimeId}-${++this.submissionSerial}`
        : undefined;
    let result: T;
    try {
      result = await (submission
        ? this.api.action<T>(this.runtimeId, action, submission)
        : this.api.action<T>(this.runtimeId, action));
    } catch (error) {
      // 只查询提交记录，不重新发送；IPC 失败也可能发生在宿主已接受之后。
      const accepted = submission
        ? await this.api.submission(submission).catch(() => null)
        : null;
      if (!accepted) throw error;
      result = { desktopTask: accepted.taskId } as T;
    }
    if (result && typeof result === 'object' && 'desktopTask' in result) {
      this.task = {
        taskId: String(result.desktopTask),
        runtimeId: this.runtimeId,
        state: 'queued',
        position: 0,
      };
      this.navigation?.changed();
    }
    return result;
  }
  /** 项目/历史切换通过此事务入口；运行时由弹层明确选择停止、等待或取消。 */
  requestSwitch(label: string, execute: () => Promise<void>): void {
    if (this.navigation) {
      void this.guard(execute);
      return;
    }
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
    if (this.navigation) return this.navigation.connect(project);
    return this.connectLocal(project);
  }
  /** 工作区绑定的独立实例使用此入口，避免导航递归。 */
  connectLocal(project: string): Promise<void> {
    if (this.connectionTask)
      return this.connectionTask.then(() => this.connectLocal(project));
    this.connectionTask = this.connectProject(project).finally(() => {
      this.connectionTask = null;
    });
    return this.connectionTask;
  }
  private async connectProject(project: string): Promise<void> {
    this.drafts.set(this.draftKey(), this.draft);
    this.saveAttachmentDraft();
    const preserve = this.historyCached;
    // 工作区将本地草稿绑定到真实会话时，输入仍属于同一对象，不按新文件键清空。
    const preserveDraft = !!this.navigation && this.newChatProject !== null;
    const draft = this.draft;
    const attachments = this.attachments;
    const generation = ++this.generation;
    const modelRevision = this.modelConfigRevision;
    this.connectionRecovery = this.connection === 'failed';
    this.connection = 'starting';
    this.setConnectionPhase(
      this.connectionRecovery ? '正在恢复连接' : '正在连接',
    );
    this.suppressTranscript = preserve;
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
      // 独立连接直接恢复历史，不再经过 switchSession；趁索引尚在缓存标题。
      // 只查新快照路径，避免跨会话连接继承旧会话名称。
      this.currentSessionTitle = this.snapshot.sessionFile
        ? this.sessionLabel(this.snapshot.sessionFile)
        : '';
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
      if (!preserve) {
        this.messages = [];
        this.accessed.clear();
        this.visible.clear();
      }
      this.run = connected.snapshot.isStreaming ? 'running' : 'idle';
      // 重连期间输入仍可编辑，不用连接开始时的副本覆盖新输入。
      if (
        !preserve &&
        !preserveDraft &&
        this.draft === draft &&
        this.attachments === attachments
      ) {
        this.draft = this.drafts.get(this.draftKey()) ?? '';
        this.restoreAttachmentDraft();
      }
      this.settings.recentProjects = [
        this.project,
        ...this.settings.recentProjects.filter(
          (p) => this.projectKey(p) !== this.projectKey(this.project),
        ),
      ].slice(0, 20);
      // 版本基线仅供设置诊断；连接成功不提示版本差异，实际 RPC 故障仍按错误展示。
      // 启动 reset 必须先消费，但不能清空正在阅读的旧视图；随后历史给出权威正文。
      this.suppressTranscript = preserve;
      try {
        await this.drain(generation);
      } finally {
        this.suppressTranscript = false;
      }
      // 设置落盘与页面数据读取互不依赖，避免跨项目新建时逐步等待。
      await Promise.all([
        this.api.save($state.snapshot(this.settings)),
        this.refreshMetadata(),
        preserve || this.loadedHistoryCount
          ? this.restoreHistory(generation)
          : this.refreshHistory(undefined, undefined, true),
        this.refreshSessions(),
        this.refreshStats(),
        this.refreshChanges(),
      ]);
      // restoreHistory 在暂存区补齐已读窗口，完成后一次提交。
      if (
        generation === this.generation &&
        (!this.navigation || !this.snapshot.sessionFile)
      )
        await this.applyProjectModel();
    } catch (error) {
      if (generation === this.generation) {
        this.connection = 'failed';
        this.error = errorMessage(error);
      }
    } finally {
      this.suppressTranscript = false;
      this.connectionRecovery = false;
      this.setConnectionPhase('');
    }
  }
  /** Channel 唤醒只触发一次拉取循环；旧 runtime/generation 的事件全部忽略。 */
  private receive(event: Wakeup, generation: number): void {
    if (generation !== this.generation) return;
    if (!this.runtimeId && this.connection === 'starting')
      this.runtimeId = event.runtimeId;
    if (event.runtimeId !== this.runtimeId) return;
    if (event.type === 'acquiring') {
      this.setConnectionPhase(
        this.connectionRecovery
          ? '正在恢复连接'
          : event.phase === 'opened'
            ? '正在加载会话'
            : event.phase === 'created'
              ? '正在创建会话'
              : '正在连接',
      );
      return;
    }
    if (event.type === 'released') {
      // 进程被借给其他会话时仅撤销租约，保留已加载正文、草稿和阅读位置。
      ++this.generation;
      this.loadedHistoryCount = this.messages.length;
      this.runtimeId = '';
      this.connection = 'disconnected';
      this.task = null;
      this.stats = null;
      this.setConnectionPhase('');
      return;
    }
    if (event.type === 'initialized') {
      const parts = this.draftParts;
      this.setConnectionPhase('');
      this.snapshot = event.snapshot;
      this.project = event.project;
      this.connection = 'ready';
      this.newChatProject = null;
      this.structuredDrafts[this.draftKey()] = parts;
      void this.refreshMetadata();
      // 启动后立刻拉取已有事件；后续唤醒仍通过 drain 合并处理。
      if (!this.restoring) void this.drain(generation);
      return;
    }
    if (event.type === 'failed') {
      this.setConnectionPhase('');
      this.initialPending = null;
      for (const timer of this.extensionTimers.values()) clearTimeout(timer);
      this.extensionTimers.clear();
      this.extensions = [];
      this.connection = 'failed';
      this.run = 'idle';
      this.error = errorMessage(event.error);
      return;
    }
    if (this.restoring && this.connection !== 'starting') {
      this.wakePending = true;
      return;
    }
    void this.drain(generation);
  }
  private wakePending = false;
  /** 唤醒可能发生在上一次空批次返回前；记录重拉请求，避免漏掉新消息。 */
  private drain(generation = this.generation): Promise<void> {
    this.wakePending = true;
    if (!this.pumpTask)
      this.pumpTask = (async () => {
        do {
          this.wakePending = false;
          await this.pump(generation);
        } while (this.wakePending && generation === this.generation);
      })().finally(() => {
        this.pumpTask = null;
        // 空批次结束到 finally 清理之间仍可能收到唤醒，必须在释放后补拉。
        if (this.wakePending && generation === this.generation)
          void this.drain(generation);
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
        for (const event of batch.events) {
          if (event.type === 'message')
            event.message = this.content.bind(event.message, this.runtimeId);
        }
        if (this.suppressTranscript) {
          const projection = { messages: [] as Message[], run: this.run };
          reduceEvents(projection, batch.events);
          this.run = projection.run;
        } else {
          reduceEvents(this, batch.events);
          if (batch.events.some((event) => event.type === 'message'))
            this.historyCached = true;
        }
        if (this.initialPending && this.messages.some((m) => m.role === 'user'))
          this.initialPending = null;
        for (const event of batch.events) {
          if (
            event.type === 'message' &&
            event.message.role === 'user' &&
            !event.message.delivery
          ) {
            const message = event.message;
            const index = this.queuedDrafts.findIndex(
              (item) =>
                (message.truncated
                  ? item.text.startsWith(message.text)
                  : item.text === message.text) &&
                attachmentImages(item.draft.attachments)
                  .map((image) => image.id)
                  .join(',') ===
                  (message.images ?? []).map((image) => image.id).join(','),
            );
            if (index >= 0) this.queuedDrafts.splice(index, 1);
          }
          // reset 是会话边界，按事件顺序清理；不能在批次末尾保留旧会话 widget。
          if (event.type === 'reset') {
            this.turnChanges = [];
            this.changesRequest++;
            this.queuedDrafts = [];
            for (const timer of this.extensionTimers.values())
              clearTimeout(timer);
            this.extensionTimers.clear();
            this.widgets = {};
            this.hiddenPlan = '';
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
  trimCache(budget = 8 * 1024 * 1024): void {
    let bytes = this.messages.reduce(
      (sum, m) =>
        sum +
        (m.text.length +
          m.thinking.length +
          (m.textParts?.reduce((total, part) => total + part.text.length, 0) ??
            0)) *
          2,
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
      if (bytes <= budget) break;
      bytes -= message.text.length * 2;
      message.text = '';
      // 普通片段的完整预览也计入缓存预算，淘汰时保留卡片标题和可重读引用。
      for (const part of message.textParts ?? []) {
        if (!part.contentRef || part.text.length <= 360) continue;
        const preview = Array.from(part.text).slice(0, 360).join('');
        bytes -= (part.text.length - preview.length) * 2;
        part.text = preview;
        part.truncated = true;
      }
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
      if (!this.extensions.some((e) => e.id === request.id)) {
        this.extensions.push(request);
        // 后台视图不挂载交互组件，超时仍须按到达时间响应，而非等用户打开。
        if (this.navigation && request.timeout && request.timeout > 0) {
          this.extensionTimers.set(
            request.id,
            setTimeout(() => {
              void this.guard(() => this.respond(request, { cancelled: true }));
            }, request.timeout),
          );
        }
      }
      return;
    }
    if (request.method === 'notify') this.notice = request.message ?? '';
    if (request.method === 'setStatus' && request.statusKey)
      this.statuses[request.statusKey] = terminalText(request.statusText ?? '');
    if (request.method === 'setWidget' && request.widgetKey) {
      const lines = (request.widgetLines ?? []).map(terminalText);
      if (
        request.widgetKey === 'plan-todos' &&
        JSON.stringify(planSteps(lines)) !==
          JSON.stringify(planSteps(this.widgets['plan-todos'] ?? []))
      )
        this.planRevision++;
      // 重复完成通知不能复活旧卡片；清空或未完成步骤标志新计划，即使文字相同。
      if (
        request.widgetKey === 'plan-todos' &&
        completedPlan(lines) !== this.hiddenPlan
      )
        this.hiddenPlan = '';
      this.widgets[request.widgetKey] = lines;
    }
    if (request.method === 'setTitle')
      this.currentSessionTitle = request.title || '';
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
    if (
      !this.extensions.some((e) => e.id === request.id) ||
      this.respondingExtensions.has(request.id)
    )
      return;
    this.respondingExtensions.add(request.id);
    const generation = this.generation;
    clearTimeout(this.extensionTimers.get(request.id));
    this.extensionTimers.delete(request.id);
    try {
      await this.action({ type: 'extension_response', id: request.id, value });
      if (generation === this.generation)
        this.extensions = this.extensions.filter((e) => e.id !== request.id);
    } finally {
      this.respondingExtensions.delete(request.id);
    }
  }
  /** 查询模型/命令可失败降级，不影响已建立的文本会话。 */
  async refreshMetadata(): Promise<void> {
    const runtime = this.runtimeId;
    const revision = this.modelConfigRevision;
    const results = await Promise.allSettled([
      this.action<{ models: Model[] }>({ type: 'models' }),
      this.action<{ levels: string[] }>({ type: 'thinking_levels' }),
      this.action<{ commands: Command[] }>({ type: 'commands' }),
    ]);
    if (runtime !== this.runtimeId || revision !== this.modelConfigRevision)
      return;
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
    if (generation === this.generation) {
      this.snapshot = snapshot;
      await this.refreshChanges();
    }
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
    if (this.navigation) return this.navigation.open(project, path);
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
      this.saveAttachmentDraft();
      this.newChatProject = null;
      this.clearDraftModel();
      this.draft = this.drafts.get(this.draftKey()) ?? '';
      this.restoreAttachmentDraft();
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
    if (this.navigation) {
      this.navigation.draft(project, false);
      return;
    }
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
  /** 重连时在暂存区补齐已读窗口，避免逐页替换导致正文闪空或滚动跳动。 */
  async restoreHistory(generation = this.generation): Promise<void> {
    const runtime = this.runtimeId;
    const previous = new Map(
      this.messages.map((message) => [message.id, message]),
    );
    const target = Math.max(this.loadedHistoryCount, this.messages.length);
    const messages: Message[] = [];
    const ids = new Set<string>();
    let before: number | undefined;
    let hasMore = false;
    this.loadingHistory = true;
    try {
      do {
        const page = await this.action<HistoryPage>({
          type: 'history',
          before,
        });
        if (generation !== this.generation || runtime !== this.runtimeId)
          return;
        if (before !== undefined && page.hasMore && page.before >= before)
          throw new Error('历史游标未前进，请重试');
        const incoming = page.messages.filter(
          (message) => !ids.has(message.id),
        );
        if (before !== undefined && page.hasMore && !incoming.length)
          throw new Error('历史加载未返回更早消息，请重试');
        for (const message of incoming) {
          ids.add(message.id);
          if (
            !message.text &&
            message.contentRef &&
            message.role !== 'toolResult'
          ) {
            const content = await this.api.content(
              runtime,
              message.contentRef,
              0,
            );
            message.text = content.text;
            message.truncated = !content.done;
          }
        }
        messages.unshift(...incoming);
        before = page.before;
        hasMore = page.hasMore;
      } while (hasMore && messages.length < target);
      if (generation !== this.generation || runtime !== this.runtimeId) return;
      const merged = messages.map((message) =>
        this.content.bind(message, runtime, previous.get(message.id)),
      );
      const afterCommit = this.beforeHistoryCommit?.();
      this.messages = merged;
      this.historyCached = true;
      this.before = before ?? 0;
      this.hasMore = hasMore;
      this.content.retain([
        ...merged,
        ...this.turnChanges.flatMap((turn) =>
          turn.files.map((file) => ({
            id: `${turn.id}:${file.path}`,
            role: 'toolResult',
            text: '',
            thinking: '',
            status: 'done',
            name: null,
            contentRef: file.contentRef,
          })),
        ),
      ]);
      afterCommit?.();
    } finally {
      if (generation === this.generation) this.loadingHistory = false;
    }
  }

  /** 历史恢复由宿主投影与分页；首次只接收最后 50 条。 */
  async refreshHistory(
    before?: number,
    beforeInsert?: () => void,
    restoring = false,
  ): Promise<void> {
    if (this.navigation && !restoring) await this.contentReady();
    if (
      before !== undefined &&
      (this.loadingHistory || (this.openingSession && !restoring))
    )
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
      for (let index = 0; index < page.messages.length; index++)
        page.messages[index] = this.content.bind(
          page.messages[index],
          this.runtimeId,
        );
      await Promise.all(
        page.messages.map(async (message) => {
          if (
            !message.text &&
            message.contentRef &&
            message.role !== 'toolResult'
          ) {
            const content = restoring
              ? await this.api.content(
                  this.runtimeId,
                  this.content.resolve(message.contentRef, this.runtimeId),
                  0,
                )
              : await this.readContent(message.contentRef, 0);
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
      this.historyCached = true;
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
    if (before !== undefined && this.navigation) await this.contentReady();
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
    if (before !== undefined)
      page.messages = page.messages.map((message) =>
        this.content.bind(message, runtime),
      );
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
  /** 初始提示词先进入宿主队列，获得名额后才分配进程；附件只在内存保留。 */
  private async submitDraft(): Promise<void> {
    if (this.submitting || this.openingSession) return;
    const draft = this.draftSnapshot();
    const {
      text,
      images,
      parts: submittedParts,
      files,
      fileStart,
    } = composePrompt(draft);
    if (draft.attachments.length && draft.text.trimStart().startsWith('/'))
      throw new Error('附件不能与斜杠命令一起发送。');
    const model = this.selectedModel;
    if (images.length && model?.input && !model.input.includes('image'))
      throw new Error('当前模型不支持图片输入。');
    const project = this.newChatProject ?? this.project;
    const fingerprint = JSON.stringify([
      project,
      text,
      images.map((image) => image.id),
      model?.provider,
      model?.id,
      this.selectedThinking,
    ]);
    if (this.initialSubmission?.fingerprint !== fingerprint)
      this.initialSubmission = { id: crypto.randomUUID(), fingerprint };
    const ranges = textRanges(submittedParts, text, files, fileStart);
    const submissionId = this.initialSubmission.id;
    const submittedRevision = this.draftRevision;
    this.submitting = true;
    this.project = project;
    this.connection = 'starting';
    // 同一未知提交重查时沿用 Channel 代次，宿主去重后原监听仍能接收事件。
    const generation = (this.initialSubmission.generation ??= ++this
      .generation);
    this.ack = 0;
    try {
      let result: { desktopTask: string; runtimeId: string };
      try {
        result = await this.api.submitNew(
          project,
          submissionId,
          {
            type: 'prompt',
            message: text,
            ...(ranges ? { textParts: ranges } : {}),
            ...(images.length
              ? {
                  images: images.map((image) => ({
                    type: 'image' as const,
                    data: image.data!,
                    mimeType: image.mimeType,
                  })),
                }
              : {}),
          },
          model ? [model.provider, model.id] : undefined,
          this.selectedThinking,
          (event) => this.receive(event, generation),
        );
      } catch (error) {
        const accepted = await this.api
          .submission(submissionId)
          .catch(() => null);
        if (!accepted) throw error;
        result = {
          desktopTask: accepted.taskId,
          runtimeId: accepted.runtimeId,
        };
      }
      this.initialSubmission = undefined;
      this.runtimeId = result.runtimeId;
      // 回执只证明宿主已接收任务；Pi 的消息会在初始化后替换本地展示。
      this.initialPending = this.messages.some((m) => m.role === 'user')
        ? null
        : {
            id: `accepted-${submissionId}`,
            textParts: localTextParts(submittedParts, text, files, fileStart),
            role: 'user',
            text,
            thinking: '',
            images,
            contentRef: null,
            status: 'done',
            name: null,
          };
      const remainingParts = this.draftParts;
      const clearSubmitted =
        this.draftRevision === submittedRevision && this.draft === draft.text;
      this.newChatProject = null;
      this.draftParts = remainingParts;
      this.connection = 'ready';
      this.task = {
        taskId: result.desktopTask,
        runtimeId: result.runtimeId,
        state: 'queued',
        position: 0,
      };
      this.taskInput = draft;
      this.sidebarPreview ||= sessionPreview(text);
      this.lastSentAt = new Date().toISOString();
      this.restored = false;
      if (clearSubmitted) this.draft = '';
      const sent = new Set(draft.attachments.map((item) => item.id));
      this.attachments = this.attachments.filter((item) => !sent.has(item.id));
      this.sentMessageRevision++;
      this.navigation?.changed();
    } catch (error) {
      this.connection = 'disconnected';
      throw error;
    } finally {
      this.submitting = false;
    }
  }
  /** 发送接受前保留原草稿，超时绝不自动重发；用户消息由 Pi 权威事件插入。 */
  async send(mode?: 'steer' | 'followUp'): Promise<void> {
    if (this.messageEdit)
      throw new Error('正在编辑历史消息，请先发送或取消编辑。');
    if (
      this.navigation &&
      this.newChatProject !== null &&
      (this.draft.trim() || this.attachments.length) &&
      !parseBuiltin(this.draft)
    ) {
      await this.submitDraft();
      return;
    }
    if (
      this.navigation &&
      this.newChatProject === null &&
      (this.draft.trim() || this.attachments.length)
    ) {
      if (this.submitting || this.openingSession || this.waitingToSend) return;
      this.waitingToSend = true;
      try {
        await this.navigation.ensure();
      } finally {
        this.waitingToSend = false;
      }
    }
    if (this.task?.state === 'queued')
      throw new Error('此会话正在排队，请等待开始或取消排队。');
    if (
      (!this.draft.trim() && !this.attachments.length) ||
      this.submitting ||
      this.openingSession ||
      (this.connection !== 'ready' && this.newChatProject === null)
    )
      return;
    const draft = this.draftSnapshot();
    const {
      text,
      images,
      parts: submittedParts,
      files,
      fileStart,
    } = composePrompt(draft);
    if (draft.attachments.length && draft.text.trimStart().startsWith('/'))
      throw new Error('附件不能与斜杠命令一起发送，请修改文字或移除附件。');
    const builtin = parseBuiltin(draft.text);
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
          const result = await this.action<{ desktopTask?: string }>({
            type: 'compact',
            instructions: builtin.args || undefined,
          });
          if (
            generation !== this.generation ||
            session !== this.snapshot.sessionFile
          )
            return;
          if (this.draft === text) this.draft = '';
          if (result?.desktopTask) {
            this.notice = '压缩任务已提交，按全局队列执行。';
            return;
          }
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
        this.draft = draft.text;
        this.draftParts = draft.parts;
        this.attachments = draft.attachments;
      }
      if (this.newChatProject !== null || this.connection !== 'ready') return;
      this.draft = draft.text;
    }
    if (this.newChatModel) {
      // 项目偏好优先于草稿沿用的选择；应用失败时保留选择，重试不再创建会话。
      await this.applyCarriedModel(this.newChatModel, this.newChatThinking);
      this.clearDraftModel();
    }
    if (
      !this.navigation &&
      this.projectModel(this.project) &&
      this.run === 'idle'
    )
      await this.applyProjectModel();
    if (this.hasPendingModel) await this.applyPendingSelection();
    if (images.length && this.modelConfigPending) {
      await this.applyModelConfig();
      if (this.modelConfigPending)
        throw new Error(`模型配置尚未应用：${this.modelConfigStatus}`);
    }
    if (
      images.length &&
      this.snapshot.model?.input &&
      !this.snapshot.model.input.includes('image')
    )
      throw new Error('当前模型不支持图片输入，请切换到支持图片的模型。');
    const ranges = textRanges(submittedParts, text, files, fileStart);
    const sessionFile = this.snapshot.sessionFile;
    const generation = this.generation;
    // 在提交前捕获，不能把请求期间刚完成的新计划误当作上一轮结果。
    const previousPlanRevision = this.planRevision;
    const finishedPlan = completedPlan(this.widgets['plan-todos'] ?? []);
    const sentAt = new Date().toISOString();
    const delivery = mode ?? (this.run !== 'idle' ? 'steer' : undefined);
    const pendingId = delivery
      ? `pending-${++this.submissionSerial}`
      : undefined;
    if (pendingId && delivery) {
      this.queuedDrafts.push({ id: pendingId, text, mode: delivery, draft });
      // 用新数组使 reducer 的 ID 索引同步包含本地占位。
      this.messages = [
        ...this.messages,
        {
          id: pendingId,
          textParts: localTextParts(submittedParts, text, files, fileStart),
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
    // 即使用户把文字改回原样，旧请求也不能清除发送期间的新编辑。
    const submittedDraftRevision = this.draftRevision;
    this.submitting = true;
    try {
      const result = await this.action<{ desktopTask?: string }>({
        type: 'prompt',
        message: text,
        ...(ranges ? { textParts: ranges } : {}),
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
      if (result?.desktopTask) {
        this.task = {
          taskId: result.desktopTask,
          runtimeId: this.runtimeId,
          state: 'queued',
          position: 0,
        };
        this.taskInput = draft;
        this.navigation?.changed();
      }
      // 迟到的提交结果不能把新会话的阅读位置拉到底部。
      if (
        generation === this.generation &&
        sessionFile === this.snapshot.sessionFile &&
        this.newChatProject === null &&
        !this.openingSession
      ) {
        this.sentMessageRevision++;
        if (finishedPlan && this.planRevision === previousPlanRevision)
          this.hiddenPlan = finishedPlan;
      }
      this.sidebarPreview ||= sessionPreview(text);
      this.lastSentAt = sentAt;
      this.restored = false;
      if (sessionFile) this.sentAt[this.sessionKey(sessionFile)] = sentAt;
      const pending = this.messages.find((message) => message.id === pendingId);
      if (pending?.delivery) pending.delivery.state = 'queued';
      if (
        this.draftRevision === submittedDraftRevision &&
        this.draft === draft.text
      )
        this.draft = '';
      const sent = new Set(draft.attachments.map((item) => item.id));
      this.attachments = this.attachments.filter((item) => !sent.has(item.id));
      if (delivery && this.run !== 'aborting' && this.run !== 'compacting')
        this.notice =
          delivery === 'steer'
            ? '引导消息已提交'
            : '后续消息已提交，将在当前任务完成后处理';
    } catch (error) {
      if (pendingId)
        this.queuedDrafts = this.queuedDrafts.filter(
          (item) => item.id !== pendingId,
        );
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
  async refreshCommandSession(applyProjectModel = true): Promise<void> {
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
    if (applyProjectModel) await this.applyProjectModel();
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
          const savedIndex = this.queuedDrafts.findIndex(
            (item) => item.text === text && item.mode === mode,
          );
          const saved =
            savedIndex >= 0
              ? this.queuedDrafts.splice(savedIndex, 1)[0]
              : undefined;
          if (saved) this.recoveredDrafts.push(saved.draft);
          else if (message?.images?.length)
            this.recoveredDrafts.push(
              snapshotDraft(text, [], message.images.map(imageAttachment)),
            );
          else this.recovered.push(text);
        }
      }
      this.messages = this.messages.filter((message) => !message.delivery);
      this.queuedDrafts = [];
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
    if (this.navigation) {
      if (path) await this.navigation.open(project, path);
      else this.navigation.draft(project, false);
      return true;
    }
    if (!this.project) return false;
    const title = path
      ? this.sessionLabel(path) || this.openingSession?.title || ''
      : '';
    this.drafts.set(this.draftKey(), this.draft);
    this.saveAttachmentDraft();
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
      this.attachmentDrafts.delete(this.draftKey());
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
    this.restoreAttachmentDraft();
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
    this.setConnectionPhase('');
    this.connection = 'stopping';
    for (const timer of this.extensionTimers.values()) clearTimeout(timer);
    this.extensionTimers.clear();
    try {
      await this.api.disconnect(force, this.runtimeId);
    } catch (error) {
      // 宿主关闭失败时仍保留原身份与事件代次，重试可先确认旧进程是否存活。
      this.connection = 'failed';
      this.error = errorMessage(error);
      throw error;
    }
    ++this.generation;
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
    if (this.hasPendingModel)
      return this.modelByKeyString(this.pendingSelection!.key);
    const preference =
      !this.navigation || this.newChatProject !== null
        ? this.projectModel()
        : undefined;
    if (this.newChatProject !== null && this.newChatModel)
      return this.modelByKeyString(this.newChatModel);
    if (preference)
      return this.modelByKey(preference.provider, preference.model);

    return this.snapshot.model;
  }
  get selectedThinking(): string {
    if (this.hasPendingModel) return this.pendingSelection!.thinking;
    if (
      this.navigation &&
      this.newChatProject !== null &&
      this.newChatThinking !== undefined
    )
      return this.newChatThinking;
    return (
      (this.navigation && this.newChatProject === null
        ? undefined
        : this.projectModel()?.thinkingLevel) ??
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
    if (
      this.navigation &&
      this.snapshot.sessionFile &&
      this.newChatProject === null
    )
      return;
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
    if (this.navigation && this.newChatProject !== null) {
      const model = this.modelByKeyString(key);
      if (!model) throw new Error('所选模型已不可用，请重新选择模型。');
      const thinking = this.selectedThinking;
      this.newChatModel = key;
      if (thinking !== 'off' && model.thinkingLevelMap?.[thinking] === null) {
        this.newChatThinking = 'off';
        this.notice = `当前模型无法使用思考强度 ${thinking}，已采用 off。`;
      }
      return;
    }
    if (this.run !== 'idle' || this.hasPendingModel) {
      this.stageModel(key, this.selectedThinking);
      return;
    }
    const model = this.models.find((m) => `${m.provider}/${m.id}` === key);
    if (!model) return;
    const project = this.newChatProject ?? this.project;
    const runtime = this.runtimeId;
    const session = this.snapshot.sessionFile;
    await this.applyModel(
      key,
      this.navigation ? undefined : this.projectModel(project)?.thinkingLevel,
    );
    if (runtime !== this.runtimeId || session !== this.snapshot.sessionFile)
      return;
    if (this.newChatProject !== null) this.newChatModel = key;
    if (!this.navigation) await this.rememberProjectModel(project);
  }
  /** 所有强度入口共用此方法，确保项目模型与强度作为一组持久化。 */
  async setThinking(level: string): Promise<void> {
    if (this.navigation && this.newChatProject !== null) {
      if (
        !thinkingLevels.some((value) => value === level) ||
        (level !== 'off' &&
          this.selectedModel?.thinkingLevelMap?.[level] === null)
      )
        throw new Error('当前模型不支持所选思考强度。');
      this.newChatThinking = level;
      return;
    }
    if (this.run !== 'idle' || this.hasPendingModel) {
      const model = this.selectedModel;
      if (!model) throw new Error('所选模型已不可用，请重新选择模型。');
      if (
        !thinkingLevels.some((value) => value === level) ||
        (level !== 'off' && model.thinkingLevelMap?.[level] === null)
      )
        throw new Error('当前模型不支持所选思考强度。');
      this.stageModel(`${model.provider}/${model.id}`, level);
      return;
    }
    const project = this.newChatProject ?? this.project;
    const runtime = this.runtimeId;
    const session = this.snapshot.sessionFile;
    const preference = this.navigation ? undefined : this.projectModel(project);
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
    if (!this.navigation && project && this.snapshot.model)
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
    if (!key || (!this.navigation && this.projectModel(this.project))) return;
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
    try {
      await this.action({
        type: 'set_model',
        provider: model.provider,
        model: model.id,
        thinking: thinkingLevel,
      });
    } catch (cause) {
      // 桥接可能已经切换模型后才失败；读取实际状态，同时保留待发送选择。
      if (runtime === this.runtimeId && session === this.snapshot.sessionFile)
        await this.syncState();
      throw cause;
    }
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
    let page;
    try {
      page = await this.readContent(message.contentRef, 0);
    } catch (error) {
      // 视图卸载并淘汰后取消的读取不应把正常回收显示为会话失败。
      if (!this.messages.includes(message)) return;
      throw error;
    }
    if (!this.messages.includes(message)) return;
    message.text = page.text;
    message.truncated = !page.done;
    this.accessed.set(message.id, ++this.accessSerial);
    this.trimCache();
  }
  /** 分块正文查询保留明确的 runtime 所有权；回收期间的只读请求等待新绑定。 */
  async readContent(id: string, offset: number) {
    const session = this.snapshot.sessionFile;
    for (;;) {
      await this.contentReady();
      if (session !== this.snapshot.sessionFile)
        throw new Error('会话已切换，正文读取已取消');
      const generation = this.generation;
      const runtime = this.runtimeId;
      const current = () =>
        generation === this.generation &&
        runtime === this.runtimeId &&
        session === this.snapshot.sessionFile;
      try {
        const page = await this.api.content(
          runtime,
          this.content.resolve(id, runtime),
          offset,
        );
        if (current()) return page;
      } catch (error) {
        if (current()) throw error;
      }
      if (
        !this.navigation ||
        !this.historyCached ||
        session !== this.snapshot.sessionFile
      )
        throw new Error('会话已切换，正文读取已取消');
      // 仅重复无副作用的读取，且必须经过 contentReady 和新运行时句柄校验。
    }
  }
  /** 共享配置 IO 与会话独立；不把凭据放入通用 Settings。 */
  loadModelConfig() {
    return this.api.modelConfig();
  }
  discoverModels(provider: ProviderConfig) {
    return this.api.discoverModels(provider);
  }
  /** 配置版本同时更新草稿目录，避免未连接草稿继续校验旧图片能力。 */
  modelConfigSaved(config: ModelSettings): void {
    this.modelConfigRevision++;
    this.modelConfigPending = true;
    this.models = this.models.map((model) => {
      const configured = config.providers
        .find((provider) => provider.id === model.provider && !provider.removed)
        ?.models.find((item) => item.id === model.id);
      if (!configured) return model;
      return {
        ...model,
        ...configured.values,
        // 缺省能力不猜测，继续展示 Pi 已确认的值，刷新后再采用新快照。
        input: configured.values.input ?? model.input,
      };
    });
    this.modelConfigStatus = '已保存，等待会话空闲后应用';
  }
  async saveModelConfig(config: ModelSettings): Promise<ModelSettings> {
    const saved = await this.api.saveModelConfig(config);
    this.modelConfigSaved(saved);
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
      // 保存发生在刷新期间时，继续应用最新版本，不能等待一个不会再来的 idle 事件。
      if (runtime === this.runtimeId && revision !== this.modelConfigRevision)
        await this.applyModelConfig();
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
