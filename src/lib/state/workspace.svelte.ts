/** 工作区管理跨项目会话身份；每个 Desktop 独占自己的事件泵和异步状态。 */
import { bridge, errorMessage, type Bridge } from '../client';
import type {
  SessionSummary,
  SidebarSessionEntry,
  TaskActivity,
} from '../types';
import { restoreParts, type DraftPart } from '../draft-parts';
import {
  hasDraft,
  persistentDraft,
  restoreDraft,
  snapshotDraft,
  type DraftSnapshot,
} from '../attachments';
import { Desktop } from './desktop.svelte';

// 内容缓存与 DOM、进程分开管理；增加内容额度不要求保留更多后台进程。
const SESSION_CONTENT_LIMIT = 12;
const SESSION_VIEW_LIMIT = 6;

export class Workspace {
  sessions = $state<Desktop[]>([]);
  active = $state<Desktop>()!;
  retained = $state<Desktop[]>([]);
  activities = $state<TaskActivity[]>([]);
  sidebarSessions = $derived.by(() => this.buildSidebarSessions());
  exitRequested = $state(false);
  exiting = $state(false);
  forceExitAvailable = $state(false);
  private exitTimer?: ReturnType<typeof setTimeout>;
  error = $state('');
  private timer?: ReturnType<typeof setInterval>;
  private polling?: Promise<void>;
  private cacheTick = 0;
  private poolRevision = 0;
  /** 页面顺序仍用于内容缓存；进程 LRU 和预留由宿主管理。 */
  private syncPool(): Promise<void> {
    const eligible = this.sessions
      .filter(
        (session) =>
          session !== this.active &&
          session.runtimeId &&
          session.connection === 'ready' &&
          session.run === 'idle' &&
          !session.submitting &&
          !session.waitingToSend &&
          !session.restoring &&
          !session.loadingHistory &&
          !session.openingSession &&
          !session.extensions.length &&
          !['queued', 'running'].includes(session.task?.state ?? ''),
      )
      .map((session) => session.runtimeId);
    return this.api.syncPool(
      ++this.poolRevision,
      this.active.runtimeId,
      eligible,
    );
  }
  private initializing = true;
  private ensuring = new Map<Desktop, Promise<void>>();
  private pendingModel = new Map<Desktop, { key: string; thinking: string }>();
  private pendingOpen = new Map<string, Promise<void>>();
  private recovery: {
    project: string;
    path?: string;
    desktopId?: string;
    createdAt?: string;
    lastSentAt?: string;
    preview?: string;
    text: string;
    parts?: DraftPart[];
    pendingText?: string;
    interrupted?: boolean;
    images?: boolean;
    snapshot?: DraftSnapshot;
    pendingDrafts?: DraftSnapshot[];
  }[] = [];
  private lastRecovery = '';
  constructor(private api: Bridge = bridge) {
    this.active = this.create();
  }
  private create(path?: string): Desktop {
    const port: Bridge = {
      ...this.api,
      submitNew: async (...args) => {
        await this.syncPool();
        return this.api.submitNew(...args);
      },
      connect: async (project, receive) => {
        await this.syncPool();
        return this.api.connect(
          project,
          receive,
          path ?? session.snapshot.sessionFile,
        );
      },
      save: async (settings) => {
        await this.api.save(settings);
        for (const session of this.sessions) session.settings = settings;
      },
      sessions: async (project, search) => {
        const result = await this.api.sessions(project, search);
        for (const session of this.sessions) session.sessions = result;
        return result;
      },
      saveModelConfig: async (config) => {
        const result = await this.api.saveModelConfig(config);
        for (const target of this.sessions) {
          if (target === session) continue;
          target.modelConfigSaved(result);
          if (target.run === 'idle') void target.applyModelConfig();
        }
        return result;
      },
    };
    const session = new Desktop(port);
    if (path) session.desktopId = `history:${this.key(path)}`;
    if (this.active) {
      session.settings = this.active.settings;
      session.sessions = this.active.sessions;
      session.expandedProjects = this.active.expandedProjects;
    }
    session.navigation = {
      open: (project, file) => this.open(project, file),
      draft: (project, preserve) => this.newDraft(project, preserve),
      connect: async (project) => {
        if (this.initializing) {
          await session.connectLocal(project);
          return;
        }
        this.newDraft(project);
        await this.ensure(this.active);
      },
      ensure: () => this.ensure(session),
      stopForArchive: (path) => this.stopForArchive(path),
      archived: (path) => this.finishArchive(path),
      changed: () => {
        void this.poll();
        this.persist();
      },
    };
    this.sessions.push(session);
    return session;
  }
  async init(): Promise<void> {
    await this.active.init();
    this.initializing = false;
    this.retain(this.active);
    try {
      const stored = JSON.parse(
        localStorage.getItem('pi-desktop-workspace-v1') || 'null',
      );
      if ([1, 2].includes(stored?.version) && Array.isArray(stored.drafts))
        this.recovery = stored.drafts;
      for (const draft of this.recovery) {
        if (!draft || typeof draft !== 'object') continue;
        if (typeof draft.text !== 'string' || typeof draft.project !== 'string')
          continue;
        if (draft.path !== undefined && typeof draft.path !== 'string')
          continue;
        const session =
          (draft.path
            ? this.sessions.find(
                (item) =>
                  item.snapshot.sessionFile &&
                  this.key(item.snapshot.sessionFile) === this.key(draft.path!),
              )
            : undefined) ?? this.create(draft.path);
        if (typeof draft.desktopId === 'string' && draft.desktopId)
          session.desktopId = draft.desktopId;
        if (typeof draft.createdAt === 'string' && draft.createdAt)
          session.createdAt = draft.createdAt;
        if (typeof draft.lastSentAt === 'string')
          session.lastSentAt = draft.lastSentAt;
        if (typeof draft.preview === 'string')
          session.sidebarPreview = draft.preview;
        session.restored = true;
        session.project = draft.project;
        session.newChatProject = draft.path ? null : draft.project;
        session.snapshot = { sessionFile: draft.path };
        const restored = restoreDraft(draft.snapshot);
        session.draft = restored?.text ?? draft.text;
        session.draftParts =
          restored?.parts ?? restoreParts(draft.parts, draft.text);
        session.attachments = restored?.attachments ?? [];
        if (Array.isArray(draft.pendingDrafts)) {
          for (const pending of draft.pendingDrafts) {
            const recovered = restoreDraft(pending);
            if (recovered && hasDraft(recovered))
              session.recoveredDrafts.push(recovered);
          }
        } else if (typeof draft.pendingText === 'string' && draft.pendingText)
          session.recovered.push(draft.pendingText);
        session.notice = draft.interrupted
          ? '上次执行中断或未启动，请检查历史后手动重新提交。'
          : '已恢复未发送的草稿。';
        if (draft.images) session.notice += ' 图片未持久保存，请重新添加附件。';
        session.unread = true;
      }
    } catch {
      this.error = '工作区恢复数据读取失败，当前输入仍可使用。';
    }
    this.timer = setInterval(() => {
      void this.poll();
      this.persist();
    }, 500);
  }
  dispose(): void {
    clearInterval(this.timer);
    clearTimeout(this.exitTimer);
    this.persist();
  }
  private key(path: string): string {
    return this.active.projectKey(path);
  }
  private retain(session: Desktop): void {
    this.retained = [
      ...this.retained.filter((item) => item !== session),
      session,
    ].slice(-SESSION_VIEW_LIMIT);
  }
  async activate(session: Desktop): Promise<void> {
    this.select(session);
    await this.syncPool();
    if (
      session.snapshot.sessionFile &&
      (session.connection !== 'ready' || session.restoring)
    )
      await this.ensure(session);
  }
  select(session: Desktop): void {
    // 折叠属于工作区导航偏好，切换独立会话不恢复它创建时的旧副本。
    session.expandedProjects = this.active.expandedProjects;
    this.active = session;
    this.sessions = [
      ...this.sessions.filter((item) => item !== session),
      session,
    ];
    session.unread = false;
    this.retain(session);
    void this.syncPool().catch((error) => {
      this.error = errorMessage(error);
    });
  }
  newDraft(project: string, preserve = false): void {
    const previous = this.active;
    // 在复用草稿或改写快照前捕获来源选择，包括当前草稿自身被再次选中的情况。
    const model = previous.selectedModel;
    const thinking = previous.selectedThinking;
    const projectKey = this.key(project);
    const commandSource =
      this.key(previous.newChatProject ?? previous.project) === projectKey
        ? previous
        : [...this.sessions]
            .reverse()
            .find(
              (item) =>
                this.key(item.project) === projectKey &&
                item.connection === 'ready',
            );
    let session = this.sessions.find(
      (item) =>
        item.newChatProject !== null &&
        this.key(item.newChatProject) === this.key(project) &&
        !item.runtimeId,
    );
    session ??= this.create();
    session.project = project;
    session.newChatProject = project;
    session.models = previous.models;
    session.levels = previous.levels;
    session.snapshot = { model, thinkingLevel: thinking };
    session.initializeDraftModel(model, thinking);
    // 命令属于项目；未连接草稿沿用已发现的元数据，连接后由实际目录替换。
    session.commands = [...(commandSource?.commands ?? session.commands)];
    if (preserve && session !== previous) {
      session.draft = previous.draft;
      session.draftParts = previous.draftParts;
      session.attachments = previous.attachments;
      previous.draft = '';
      previous.attachments = [];
    }
    this.select(session);
  }
  ensure(session: Desktop): Promise<void> {
    const pending = this.ensuring.get(session);
    if (pending) return pending;
    session.restoring = true;
    const task = this.ensureLocal(session)
      .catch((error) => {
        session.connection = 'failed';
        session.error = errorMessage(error);
        throw error;
      })
      .finally(() => {
        this.ensuring.delete(session);
        session.finishRestore();
      });
    this.ensuring.set(session, task);
    return task;
  }
  private async ensureLocal(session: Desktop): Promise<void> {
    // 等宿主完成回收及旧租约通知，再决定是否需要重新获取。
    await this.syncPool();
    if (session.runtimeId && session.connection === 'ready') {
      await this.applyPendingModel(session);
      return;
    }
    if (session.runtimeId && session.connection === 'failed') {
      let alive = false;
      try {
        await session.syncState();
        alive = true;
      } catch {
        /* 原实例已不可查询，定向回收后再显式恢复。 */
      }
      if (alive) {
        session.connection = 'ready';
        await session.restoreHistory();
        await session.refreshMetadata();
        // 连接已成功但模型应用失败时，重试仍须完成原草稿的选择。
        await this.applyPendingModel(session);
        return;
      }
      await session.disconnect(true).catch(() => {});
    }
    const project = session.newChatProject ?? session.project;
    const isNew = session.newChatProject !== null;
    const model = session.selectedModel;
    const thinking = session.selectedThinking;
    if (model && isNew)
      this.pendingModel.set(session, {
        key: `${model.provider}/${model.id}`,
        thinking,
      });
    if (!session.historyCached)
      session.openingSession = {
        path: '',
        title: session.snapshot.sessionFile ? session.sessionTitle : '新对话',
      };
    try {
      await session.connectLocal(project);
      if (session.connection !== 'ready')
        throw new Error(session.error || '会话连接失败');
      await this.applyPendingModel(session);
    } finally {
      session.openingSession = null;
    }
  }
  private async applyPendingModel(session: Desktop): Promise<void> {
    const selection = this.pendingModel.get(session);
    if (!selection) return;
    await session.setModel(selection.key);
    await session.setThinking(selection.thinking);
    this.pendingModel.delete(session);
  }
  async open(project: string, path: string): Promise<void> {
    const key = this.key(path);
    if (this.pendingOpen.has(key)) return this.pendingOpen.get(key);
    // 优先查找已有实例，避免重复创建导致后端拒绝连接
    const existing = this.sessions.find(
      (item) =>
        item.snapshot.sessionFile &&
        this.key(item.snapshot.sessionFile) === key,
    );
    if (existing) {
      // 复用实例时确保 project 一致
      existing.project = project;
      await this.activate(existing);
      return;
    }
    // 未找到实例才创建新 Desktop
    const session = this.create(path);
    session.project = project;
    session.snapshot = { sessionFile: path };
    this.select(session);
    const task = this.ensure(session).finally(() =>
      this.pendingOpen.delete(key),
    );
    this.pendingOpen.set(key, task);
    await task;
  }
  get running(): number {
    return this.activities.filter((task) => task.state === 'running').length;
  }
  get queued(): number {
    return this.activities.filter((task) => task.state === 'queued').length;
  }
  /** 合并展示来源，不把本地标识伪装成文件路径；状态变化不参与排序。 */
  private buildSidebarSessions(): SidebarSessionEntry[] {
    const desktop = this.active;
    const owners = new Map(
      this.sessions.flatMap((session) =>
        session.snapshot.sessionFile
          ? [[this.key(session.snapshot.sessionFile), session] as const]
          : [],
      ),
    );
    const entries = new Map<string, SidebarSessionEntry>();
    const add = (session: Desktop | undefined, history?: SessionSummary) => {
      const path = session?.snapshot.sessionFile || history?.path;
      const cwd = session
        ? (session.newChatProject ?? session.project)
        : history!.cwd;
      const archived =
        !!(path && desktop.sidebarItem('session', path)?.state) ||
        this.projectArchived(cwd);
      if (archived && (!session || !this.isExecuting(session))) return;
      const summary = (
        session?.sidebarPreview ||
        session?.taskInput?.text ||
        session?.draft ||
        session?.recovered.at(-1) ||
        session?.recoveredDrafts.at(-1)?.text ||
        session?.attachments
          .map((item) =>
            item.kind === 'path' ? item.name : (item.image.name ?? '图片'),
          )
          .join('、') ||
        ''
      )
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80);
      const content = !!(
        summary ||
        session?.attachments.length ||
        session?.recoveredDrafts.length
      );
      if (
        !history &&
        !path &&
        session &&
        !content &&
        !session.task &&
        !session.restored &&
        !this.isExecuting(session)
      )
        return;
      const id = session?.desktopId ?? `history:${this.key(path!)}`;
      entries.set(id, {
        id,
        path,
        desktopId: session?.desktopId,
        cwd,
        // 历史通常没有显式名称，应使用首条提示摘要，不能让占位名称遮住摘要。
        name:
          (path ? desktop.sidebarItem('session', path)?.name : '') ||
          history?.name ||
          history?.preview ||
          session?.snapshot.sessionName ||
          summary ||
          (session?.restored ? '恢复的会话' : '新对话'),
        preview: history?.preview || summary,
        // 本地草稿绑定文件后保留原创建时间；否则同毫秒发送时索引时间会改变排序。
        timestamp:
          session && !session.desktopId.startsWith('history:')
            ? session.createdAt
            : history?.timestamp || session?.createdAt || '',
        modified: history?.modified ?? 0,
        lastPromptAt: session?.lastSentAt || history?.lastPromptAt,
        warning: history?.warning ?? null,
        status: session ? this.sessionStatus(session) : '',
        unread:
          !!session?.unread &&
          !session.restored &&
          !this.isExecuting(session) &&
          !session.error,
        archived,
      });
    };
    const indexed = new Set<string>();
    for (const history of desktop.sessions) {
      const key = this.key(history.path);
      if (indexed.has(key)) continue;
      indexed.add(key);
      add(owners.get(key), history);
    }
    for (const session of this.sessions) {
      if (
        !session.snapshot.sessionFile ||
        !indexed.has(this.key(session.snapshot.sessionFile))
      )
        add(session);
    }
    const activity = (entry: SidebarSessionEntry) =>
      entry.lastPromptAt || (!entry.path ? entry.timestamp : '');
    return [...entries.values()].sort(
      (a, b) =>
        activity(b).localeCompare(activity(a)) ||
        b.timestamp.localeCompare(a.timestamp) ||
        a.id.localeCompare(b.id),
    );
  }
  get pinnedSessions(): SidebarSessionEntry[] {
    const byPath = new Map(
      this.sidebarSessions.flatMap((entry) =>
        entry.path ? [[this.key(entry.path), entry] as const] : [],
      ),
    );
    return this.active.settings.pinnedSessions.flatMap((path) => {
      const entry = byPath.get(this.key(path));
      return entry ? [entry] : [];
    });
  }
  get projects(): { path: string; sessions: SidebarSessionEntry[] }[] {
    const groups = new Map<
      string,
      { path: string; sessions: SidebarSessionEntry[] }
    >();
    for (const entry of this.sidebarSessions) {
      const key = this.key(entry.cwd);
      if (!groups.has(key)) groups.set(key, { path: entry.cwd, sessions: [] });
      groups.get(key)!.sessions.push(entry);
    }
    for (const path of [
      this.active.project,
      ...this.active.settings.recentProjects,
    ]) {
      if (path && !this.projectArchived(path) && !groups.has(this.key(path)))
        groups.set(this.key(path), { path, sessions: [] });
    }
    const rank = new Map(
      this.active.settings.projectOrder.map((path, index) => [
        this.key(path),
        index,
      ]),
    );
    return [...groups.values()].sort(
      (a, b) =>
        (rank.get(this.key(a.path)) ?? Infinity) -
          (rank.get(this.key(b.path)) ?? Infinity) ||
        this.key(a.path).localeCompare(this.key(b.path)),
    );
  }
  projectArchived(path: string): boolean {
    return !!this.active.sidebarItem('project', path)?.state;
  }
  private isExecuting(session: Desktop): boolean {
    return (
      !!session.extensions.length ||
      session.run !== 'idle' ||
      ['queued', 'running'].includes(session.task?.state ?? '')
    );
  }
  private sessionStatus(session: Desktop): string {
    if (session.extensions.length) return '待你处理';
    if (session.error || session.task?.state === 'failed') return '失败';
    if (session.task?.state === 'queued') return '排队中';
    if (session.task?.state === 'running' || session.run !== 'idle')
      return session.run === 'aborting' ? '停止中' : '运行中';
    if (session.task?.state === 'completed') return '已完成';
    // 本地恢复只是加载来源，不单独显示状态；未发送内容仍按草稿判断。
    if (
      !session.snapshot.sessionFile &&
      (session.draft.trim() ||
        session.attachments.length ||
        session.recovered.length ||
        session.recoveredDrafts.length)
    )
      return '草稿';
    return '';
  }
  isSelected(entry: SidebarSessionEntry): boolean {
    return entry.desktopId === this.active.desktopId;
  }
  isPinned(entry: SidebarSessionEntry): boolean {
    return (
      !!entry.path &&
      this.active.settings.pinnedSessions.some(
        (path) => this.key(path) === this.key(entry.path!),
      )
    );
  }
  async togglePin(entry: SidebarSessionEntry): Promise<void> {
    if (!entry.path) return;
    const existing = this.active.settings.pinnedSessions.find(
      (path) => this.key(path) === this.key(entry.path!),
    );
    await this.active.togglePin(existing ?? entry.path);
  }
  async openEntry(entry: SidebarSessionEntry): Promise<void> {
    const session = this.sessions.find(
      (item) => item.desktopId === entry.desktopId,
    );
    if (session) await this.activate(session);
    else if (entry.path) await this.open(entry.cwd, entry.path);
  }
  async moveProject(
    source: string,
    target: string,
    after = false,
  ): Promise<void> {
    await this.active.moveProject(
      source,
      target,
      after,
      this.projects.map((project) => project.path),
    );
  }
  /** 会话归档先停止实际所属实例；项目归档仍仅收起项目，不终止其任务。 */
  private async stopForArchive(path: string): Promise<void> {
    const session = this.sessions.find(
      (entry) =>
        entry.snapshot.sessionFile &&
        this.key(entry.snapshot.sessionFile) === this.key(path),
    );
    if (!session) return;
    if (session.submitting || session.waitingToSend || session.restoring)
      throw new Error('会话正在提交或连接，请稍后重试归档。');
    if (session.task?.state === 'queued') await this.cancel(session);
    if (this.isExecuting(session)) {
      await session.stop();
      const deadline = Date.now() + 5000;
      // abort 回执与任务结算独立到达；同一次归档等待两者就绪，不能要求再次点击。
      while (true) {
        await this.poll();
        if (session.run !== 'idle' && session.connection === 'ready') {
          await session.syncState();
          if (!session.snapshot.isStreaming && !session.snapshot.isCompacting)
            session.run = 'idle';
        }
        if (!this.isExecuting(session)) {
          session.notice = '';
          break;
        }
        if (Date.now() >= deadline)
          throw new Error('停止超过 5 秒，请等待停止完成后重试归档。');
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
      }
    }
  }
  /** 保存成功才退出当前归档会话；保留对象和草稿，卸载其视图以免正文残留。 */
  private finishArchive(path: string): void {
    const previous = this.active;
    if (
      previous.snapshot.sessionFile &&
      this.key(previous.snapshot.sessionFile) === this.key(path)
    ) {
      this.newDraft(previous.project);
      this.active.sidebarFeedback = previous.sidebarFeedback;
      this.active.sidebarUndo = previous.sidebarUndo;
      previous.sidebarFeedback = '';
      previous.sidebarUndo = null;
    }
    this.retained = this.retained.filter(
      (session) =>
        !session.snapshot.sessionFile ||
        this.key(session.snapshot.sessionFile) !== this.key(path),
    );
    this.persist();
  }
  async cancel(session: Desktop): Promise<void> {
    if (!session.task) return;
    await this.api.cancelTask(session.task.taskId);
    session.task = { ...session.task, state: 'cancelled', position: 0 };
    session.initialPending = null;
    const input = session.taskInput;
    if (input) session.recoveredDrafts.push(input);
    session.taskInput = null;
    if (
      !session.snapshot.sessionFile &&
      session.runtimeId.startsWith('reserved-')
    ) {
      session.runtimeId = '';
      session.connection = 'disconnected';
      session.newChatProject = session.project;
    }
    await this.poll();
  }
  /** 并发调用共享正在进行的刷新；归档等待真正结算，不能把跳过刷新视作已完成。 */
  private poll(): Promise<void> {
    if (this.polling) return this.polling;
    this.polling = this.pollLocal().finally(() => {
      this.polling = undefined;
    });
    return this.polling;
  }
  private async pollLocal(): Promise<void> {
    try {
      const activities = await this.api.activity();
      if (!Array.isArray(activities)) return;
      this.activities = activities;
      for (const session of this.sessions) {
        const task = activities.find(
          (item) => item.runtimeId === session.runtimeId,
        );
        if (!task) continue;
        if (session.task?.state !== task.state) {
          if (task.state === 'failed') {
            session.setConnectionPhase('');
            session.run = 'idle';
            session.error = task.error || '任务执行失败';
            if (
              !session.snapshot.sessionFile &&
              session.runtimeId.startsWith('reserved-')
            ) {
              // 启动前失败才需要找回未发送输入；响应失败（含重试耗尽）仅展示错误。
              if (session.taskInput)
                session.recoveredDrafts.push(session.taskInput);
              session.runtimeId = '';
              session.connection = 'disconnected';
              session.newChatProject = session.project;
            }
          }
          if (task.state === 'stopped') {
            session.setConnectionPhase('');
            session.run = 'idle';
            if (
              !session.snapshot.sessionFile &&
              session.runtimeId.startsWith('reserved-')
            ) {
              if (session.taskInput)
                session.recoveredDrafts.push(session.taskInput);
              session.runtimeId = '';
              session.connection = 'disconnected';
              session.newChatProject = session.project;
            }
          }
          if (['failed', 'stopped'].includes(task.state))
            session.initialPending = null;
          if (['completed', 'failed', 'stopped'].includes(task.state)) {
            session.unread = session !== this.active;
            session.taskInput = null;
          }
        }
        session.task = task;
      }
      await this.syncPool();
      let cached = this.sessions.filter(
        (session) => session.historyCached,
      ).length;
      for (const session of this.sessions) {
        if (cached <= SESSION_CONTENT_LIMIT) break;
        if (
          !session.historyCached ||
          session === this.active ||
          this.retained.includes(session) ||
          this.isExecuting(session) ||
          session.submitting ||
          session.waitingToSend ||
          session.restoring ||
          session.loadingHistory
        )
          continue;
        session.evictContent();
        cached--;
      }
      // 全量正文预算检查降为每五秒一次，避免后台每次状态轮询重复扫描长对话。
      this.cacheTick = (this.cacheTick + 1) % 10;
      if (this.cacheTick !== 0) return;
      const size = (session: Desktop) =>
        session.messages.reduce(
          (total, message) =>
            total +
            (message.text.length +
              message.thinking.length +
              (message.textParts?.reduce(
                (sum, part) => sum + part.text.length,
                0,
              ) ?? 0)) *
              2,
          0,
        );
      let bytes = this.sessions.reduce(
        (total, session) => total + size(session),
        0,
      );
      for (const session of this.sessions.filter(
        (item) => item !== this.active,
      )) {
        if (bytes <= 32 * 1024 * 1024) break;
        const before = size(session);
        session.trimCache(Math.max(0, before - (bytes - 32 * 1024 * 1024)));
        bytes -= before - size(session);
      }
    } catch (error) {
      this.error = errorMessage(error);
    }
  }
  /** 单键替换保存草稿和中断快照；图片正文始终不写入 localStorage。 */
  persist(): void {
    if (this.exiting) return;
    const drafts = this.sessions.flatMap((session) => {
      const interrupted =
        !!session.task && ['queued', 'running'].includes(session.task.state);
      const pending = interrupted ? session.taskInput : null;
      const current = session.draftSnapshot();
      const recovered = [
        ...(pending ? [pending] : []),
        ...session.recoveredDrafts,
        ...session.recovered.map((text) => snapshotDraft(text, [], [])),
      ];
      const images = [current, ...recovered].some((draft) =>
        draft.attachments.some((item) => item.kind === 'image'),
      );
      if (
        !current.text &&
        !current.attachments.length &&
        !recovered.length &&
        !interrupted
      )
        return [];
      return [
        {
          project: session.newChatProject ?? session.project,
          path: session.snapshot.sessionFile,
          desktopId: session.desktopId,
          createdAt: session.createdAt,
          lastSentAt: session.lastSentAt,
          preview: session.sidebarPreview,
          text: current.text,
          snapshot: persistentDraft(current),
          pendingDrafts: recovered.map(persistentDraft),
          interrupted,
          images,
        },
      ];
    });
    const value = JSON.stringify({ version: 2, drafts });
    if (value === this.lastRecovery) return;
    try {
      localStorage.setItem('pi-desktop-workspace-v1', value);
      this.lastRecovery = value;
    } catch {
      this.error = '草稿未能保存到本机，请在退出前复制重要输入。';
    }
  }
  async requestExit(): Promise<void> {
    await this.poll();
    if (
      this.running ||
      this.queued ||
      this.sessions.some((session) => session.run !== 'idle')
    )
      this.exitRequested = true;
    else await this.exit();
  }
  async exit(force = false): Promise<void> {
    if (this.exiting && !force) return;
    this.persist();
    this.exiting = true;
    this.forceExitAvailable = false;
    clearTimeout(this.exitTimer);
    this.exitTimer = setTimeout(() => {
      this.forceExitAvailable = true;
    }, 5000);
    try {
      await this.api.pauseTasks(true);
      if (!force)
        await Promise.allSettled(
          this.sessions
            .filter((session) => session.run !== 'idle')
            .map((session) => session.stop()),
        );
      await this.api.exit(force);
    } catch (error) {
      clearTimeout(this.exitTimer);
      this.error = errorMessage(error);
      this.exiting = false;
      await this.api.pauseTasks(false);
    }
  }
}
