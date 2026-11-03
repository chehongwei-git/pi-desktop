/** 多项目真实会话门面测试：独立 Channel、模型与排队恢复，不连接外部模型。 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Workspace } from './workspace.svelte';
import { bridge, type Bridge } from '../client';
import {
  defaultSettings,
  type Snapshot,
  type Message,
  type SessionSummary,
  type Wakeup,
  type TaskActivity,
} from '../types';
const workspaces: Workspace[] = [];
afterEach(() => {
  for (const workspace of workspaces.splice(0)) workspace.dispose();
  localStorage.clear();
});
function fixture() {
  let serial = 0;
  const faults = { lostResponse: false };
  const histories = new Map<string, Message[]>();
  const content = vi.fn(
    async (_runtime: string, id: string, _offset: number) => ({
      text: id,
      next: id.length,
      done: true,
    }),
  );
  const states = new Map<string, Snapshot>();
  const channels = new Map<string, (event: Wakeup) => void>();
  const pending = new Map<string, any[]>();
  const tasks: TaskActivity[] = [];
  const submissions = new Map<string, TaskActivity>();
  const action = vi.fn(
    async (runtime: string, action: any, submission?: string) => {
      const state = states.get(runtime)!;
      if (action.type === 'state') return state;
      if (action.type === 'history')
        return {
          messages: structuredClone(
            histories.get(state.sessionFile ?? '') ?? [],
          ),
          before: 0,
          hasMore: false,
        };
      if (action.type === 'models')
        return {
          models: [
            { provider: 'mock', id: 'a', name: 'A' },
            { provider: 'mock', id: 'b', name: 'B' },
          ],
        };
      if (action.type === 'thinking_levels') return { levels: ['off', 'high'] };
      if (action.type === 'commands') return { commands: [] };
      if (action.type === 'set_model')
        state.model = {
          provider: action.provider,
          id: action.model,
          name: action.model,
        };
      if (action.type === 'set_thinking') state.thinkingLevel = action.level;
      if (action.type === 'prompt') {
        expect(submission).toBeTruthy();
        const task = {
          taskId: `task-${tasks.length}`,
          runtimeId: runtime,
          state: 'queued' as const,
          position: tasks.length + 1,
        };
        tasks.push(task);
        if (submission) submissions.set(submission, task);
        return { desktopTask: task.taskId };
      }
      return {};
    },
  );
  const disconnect = vi.fn(async () => {});
  const api: Bridge = {
    ...bridge,
    settings: async () => structuredClone(defaultSettings),
    save: async () => {},
    sessions: async () => [],
    connect: async (project, receive, path) => {
      const runtimeId = `r-${++serial}`;
      const snapshot = {
        sessionFile: path ?? `${project}/${serial}.jsonl`,
        cwd: project,
        model: { provider: 'mock', id: 'a', name: 'A' },
        thinkingLevel: 'off',
      };
      states.set(runtimeId, snapshot);
      channels.set(runtimeId, receive);
      return { runtimeId, project, snapshot, version: '1.4.0', verified: true };
    },
    events: async (runtime) => {
      const events = pending.get(runtime) ?? [];
      pending.set(runtime, []);
      return { runtimeId: runtime, sequence: 1, events };
    },
    action: action as Bridge['action'],
    disconnect,
    content,
    submitNew: async (
      project,
      submission,
      prompt,
      model,
      thinking,
      receive,
    ) => {
      const connected = await api.connect(project, receive, undefined);
      receive({
        type: 'initialized',
        runtimeId: connected.runtimeId,
        snapshot: connected.snapshot,
        project,
      });
      const result = await action(connected.runtimeId, prompt, submission);
      if (faults.lostResponse) {
        faults.lostResponse = false;
        throw new Error('lost response');
      }
      return { ...result, runtimeId: connected.runtimeId } as {
        desktopTask: string;
        runtimeId: string;
      };
    },
    activity: async () => [...tasks],
    submission: async (id) => submissions.get(id) ?? null,
    cancelTask: async (id) => {
      const task = tasks.find((item) => item.taskId === id)!;
      task.state = 'cancelled';
    },
  } satisfies Bridge;
  const workspace = new Workspace(api);
  workspaces.push(workspace);
  return {
    workspace,
    api,
    faults,
    histories,
    content,
    action,
    disconnect,
    states,
    tasks,
    emit(runtime: string, events: any[]) {
      pending.set(runtime, events);
      channels.get(runtime)!({ type: 'available', runtimeId: runtime });
    },
  };
}
function summary(path: string, cwd: string): SessionSummary {
  return {
    path,
    cwd,
    id: path,
    name: 'indexed title',
    preview: 'indexed input',
    timestamp: '2025-01-01T00:00:00.000Z',
    modified: 0,
    warning: null,
  };
}
describe('cross-project workspace', () => {
  it('normalizes Windows drive roots, UNC and long-path aliases without changing POSIX case', () => {
    const { workspace } = fixture();
    const key = (path: string) => workspace.active.projectKey(path);
    expect(key('C:/')).toBe(key('c:/'));
    expect(key(String.raw`\\?\C:\Sessions\One.jsonl`)).toBe(
      key('c:/sessions/one.jsonl'),
    );
    expect(key(String.raw`\\?\UNC\SERVER\Share\One.jsonl`)).toBe(
      key('//server/share/one.jsonl'),
    );
    expect(key('/')).not.toBe(key(''));
    expect(key('/Work/One')).not.toBe(key('/work/one'));
  });
  it('keeps two sessions in each of two projects alive and routes background events', async () => {
    const { workspace, emit, disconnect } = fixture();
    await workspace.init();
    for (const [project, path] of [
      ['/a', '/a/one.jsonl'],
      ['/a', '/a/two.jsonl'],
      ['/b', '/b/one.jsonl'],
      ['/b', '/b/two.jsonl'],
    ]) {
      await workspace.open(project, path);
      workspace.active.draft = path;
      await workspace.active.send();
    }
    const sessions = workspace.sessions.filter((item) => item.task);
    expect(sessions).toHaveLength(4);
    const first = sessions[0];
    emit(first.runtimeId, [
      { type: 'run', state: 'running' },
      { type: 'delta', id: 'background', field: 'text', delta: 'background' },
    ]);
    await vi.waitFor(() => expect(first.run).toBe('running'));
    expect(workspace.active).not.toBe(first);
    expect(workspace.active.run).toBe('idle');
    for (const session of sessions)
      expect(disconnect).not.toHaveBeenCalledWith(false, session.runtimeId);
    const runtime = first.runtimeId;
    await workspace.open('/a', '/a/one.jsonl');
    expect(workspace.active).toBe(first);
    expect(first.runtimeId).toBe(runtime);
  });
  it('changes a model only in the target session and opens a path once', async () => {
    const { workspace, states } = fixture();
    await workspace.init();
    await Promise.all([
      workspace.open('/a', '/a/one.jsonl'),
      workspace.open('/a', '/a/one.jsonl'),
    ]);
    const first = workspace.active;
    await first.setModel('mock/b');
    await workspace.open('/a', '/a/two.jsonl');
    expect(workspace.active.selectedModel?.id).toBe('a');
    expect(states.get(first.runtimeId)?.model?.id).toBe('b');
    expect(
      workspace.sessions.filter(
        (item) => item.snapshot.sessionFile === '/a/one.jsonl',
      ),
    ).toHaveLength(1);
    expect(workspace.active.settings.projectModels ?? []).toEqual([]);
  });
  it('reuses existing Desktop when opening the same session path', async () => {
    const { workspace, api } = fixture();
    await workspace.init();
    await workspace.open('/a', '/a/one.jsonl');
    const first = workspace.active;
    expect(first.snapshot.sessionFile).toBe('/a/one.jsonl');
    const connectSpy = vi.spyOn(api, 'connect');
    await workspace.open('/a', '/a/one.jsonl');
    expect(workspace.active).toBe(first);
    expect(connectSpy).not.toHaveBeenCalled();
  });
  it('handles concurrent open calls for the same session', async () => {
    const { workspace } = fixture();
    await workspace.init();
    await Promise.all([
      workspace.open('/a', '/a/one.jsonl'),
      workspace.open('/a', '/a/one.jsonl'),
    ]);
    const sessions = workspace.sessions.filter(
      (s) => s.snapshot.sessionFile === '/a/one.jsonl',
    );
    expect(sessions).toHaveLength(1);
  });
  it('keeps six cached views while releasing all background idle processes', async () => {
    const { workspace, disconnect } = fixture();
    await workspace.init();
    for (let index = 1; index < 6; index++)
      await workspace.open('/a', `/a/${index}.jsonl`);
    const sessions = [...workspace.sessions];
    await workspace['poll']();
    expect(workspace.retained).toHaveLength(6);
    expect(sessions.every((session) => session.historyCached)).toBe(true);
    expect(sessions.filter((session) => session.runtimeId)).toEqual([
      workspace.active,
    ]);
    expect(disconnect).toHaveBeenCalledTimes(5);
    for (const session of sessions) {
      await workspace.activate(session);
      await workspace['poll']();
      expect(workspace.retained).toContain(session);
      expect(session.connection).toBe('ready');
      expect(session.historyCached).toBe(true);
    }
  });
  it('keeps twelve content caches and six views, evicting the least recently visited content', async () => {
    const { workspace } = fixture();
    await workspace.init();
    const first = workspace.active;
    first.draft = '保留草稿';
    first.scrollState = { top: 120, follow: false };
    first.toolViews = { tool: { output: true } };
    for (let index = 1; index < 12; index++)
      await workspace.open('/a', `/a/${index}.jsonl`);
    await workspace['poll']();
    expect(
      workspace.sessions.filter((session) => session.historyCached),
    ).toHaveLength(12);
    expect(workspace.retained).toHaveLength(6);
    // 重访使第一个会话变为最近访问，淘汰对象应是第二个。
    const oldest = workspace.sessions[1];
    await workspace.activate(first);
    await workspace.open('/b', '/b/thirteenth.jsonl');
    await workspace['poll']();
    expect(oldest.historyCached).toBe(false);
    expect(first.historyCached).toBe(true);
    expect(first.draft).toBe('保留草稿');
    expect(first.scrollState).toEqual({ top: 120, follow: false });
    expect(first.toolViews).toEqual({ tool: { output: true } });
    expect(
      workspace.sessions.filter((session) => session.historyCached),
    ).toHaveLength(12);
    expect(workspace.retained).toHaveLength(6);
    expect(workspace.retained).not.toContain(oldest);
  });
  it.each([
    'running',
    'queued',
    'extension',
    'submitting',
    'restoring',
    'history',
    'sending',
  ] as const)(
    'protects a %s session when the idle cache overflows',
    async (state) => {
      const { workspace, disconnect } = fixture();
      await workspace.init();
      const protectedSession = workspace.active;
      const runtime = protectedSession.runtimeId;
      if (state === 'running') protectedSession.run = 'running';
      else if (state === 'submitting') protectedSession.submitting = true;
      else if (state === 'restoring') protectedSession.restoring = true;
      else if (state === 'history') protectedSession.loadingHistory = true;
      else if (state === 'sending') protectedSession.waitingToSend = true;
      else if (state === 'queued')
        protectedSession.task = {
          taskId: 'protected-task',
          runtimeId: runtime,
          state: 'queued',
          position: 1,
        };
      else
        protectedSession.extensions = [
          { id: 'confirm', type: 'extension_ui_request', method: 'confirm' },
        ];
      // 保护会话以外再打开七个空闲会话，确保确实发生淘汰。
      for (let index = 1; index <= 7; index++)
        await workspace.open('/a', `/a/${index}.jsonl`);
      await workspace['poll']();
      expect(disconnect).toHaveBeenCalledTimes(6);
      expect(disconnect).not.toHaveBeenCalledWith(false, runtime);
      expect(protectedSession.runtimeId).toBe(runtime);
      expect(protectedSession.connection).toBe('ready');
    },
  );
  it('shows cached content through reconnect, preserves edits and rebinds old references before reading', async () => {
    const { workspace, api, histories, content, emit } = fixture();
    histories.set('/a/cached.jsonl', [
      {
        id: 'message',
        role: 'assistant',
        text: '已加载内容',
        thinking: '',
        contentRef: 'body-1',
        status: 'done',
        name: null,
      },
    ]);
    await workspace.init();
    await workspace.open('/a', '/a/cached.jsonl');
    const cached = workspace.active;
    const handle = cached.messages[0].contentRef!;
    cached.toolViews = { message: { output: true } };
    cached.draft = '旧草稿';
    await workspace.open('/b', '/b/other.jsonl');
    await workspace['poll']();
    expect(cached.runtimeId).toBe('');
    expect(cached.messages[0].text).toBe('已加载内容');
    expect(workspace.retained).toContain(cached);
    // 隐藏视图读取只等待恢复，不能自行唤醒进程。
    const original = api.connect;
    const connect = vi.spyOn(api, 'connect');
    const reading = cached.readContent(handle, 0);
    await Promise.resolve();
    expect(connect).not.toHaveBeenCalled();
    expect(content).not.toHaveBeenCalled();
    let resume!: () => void;
    connect.mockImplementationOnce(async (...args) => {
      await new Promise<void>((resolve) => {
        resume = resolve;
      });
      const result = await original(...args);
      emit(result.runtimeId, [{ type: 'reset' }]);
      return result;
    });
    histories.get('/a/cached.jsonl')![0].contentRef = 'body-9';
    const opening = workspace.activate(cached);
    await vi.waitFor(() => expect(resume).toBeTypeOf('function'));
    expect(cached.openingSession).toBeNull();
    expect(cached.restoring).toBe(true);
    expect(cached.messages[0].text).toBe('已加载内容');
    cached.draft = '连接期间新编辑';
    await workspace['poll']();
    resume();
    await opening;
    await expect(reading).resolves.toMatchObject({ text: 'body-9' });
    expect(content).toHaveBeenCalledWith(cached.runtimeId, 'body-9', 0);
    expect(cached.messages[0].contentRef).toBe(handle);
    expect(cached.messages[0].text).toBe('已加载内容');
    expect(cached.draft).toBe('连接期间新编辑');
    expect(cached.toolViews).toEqual({ message: { output: true } });
    expect(cached.restoring).toBe(false);
  });
  it('retains cached content on reconnect failure and retries without losing the draft', async () => {
    const { workspace, api, histories } = fixture();
    histories.set('/a/cached.jsonl', [
      {
        id: 'm',
        role: 'assistant',
        text: '可离线阅读',
        thinking: '',
        contentRef: null,
        status: 'done',
        name: null,
      },
    ]);
    await workspace.init();
    await workspace.open('/a', '/a/cached.jsonl');
    const cached = workspace.active;
    cached.draft = '继续编辑';
    await workspace.open('/b', '/b/other.jsonl');
    await workspace['poll']();
    vi.spyOn(api, 'connect').mockRejectedValueOnce(new Error('offline'));
    await expect(workspace.activate(cached)).rejects.toThrow('offline');
    expect(cached.connection).toBe('failed');
    expect(cached.messages[0].text).toBe('可离线阅读');
    expect(cached.draft).toBe('继续编辑');
    vi.spyOn(api, 'connect').mockRejectedValueOnce(new Error('still offline'));
    await expect(cached.send()).rejects.toThrow('still offline');
    expect(cached.draft).toBe('继续编辑');
    expect(cached.waitingToSend).toBe(false);
    await workspace.ensure(cached);
    expect(cached.connection).toBe('ready');
    expect(cached.draft).toBe('继续编辑');
  });
  it('waits for connection before sending once', async () => {
    const { workspace, api, tasks } = fixture();
    await workspace.init();
    const cached = workspace.active;
    await workspace.open('/b', '/b/other.jsonl');
    await workspace['poll']();
    workspace.select(cached);
    cached.draft = '只发一次';
    const original = api.connect;
    let resume!: () => void;
    vi.spyOn(api, 'connect').mockImplementationOnce(async (...args) => {
      await new Promise<void>((resolve) => {
        resume = resolve;
      });
      return original(...args);
    });
    const sending = cached.send();
    await vi.waitFor(() => expect(resume).toBeTypeOf('function'));
    await cached.send();
    expect(tasks).toHaveLength(0);
    expect(cached.waitingToSend).toBe(true);
    resume();
    await sending;
    expect(tasks).toHaveLength(1);
    expect(cached.draft).toBe('');
    expect(cached.waitingToSend).toBe(false);
  });
  it('recovers a failed native close without duplicating the runtime or losing its event channel', async () => {
    const { workspace, api, disconnect, emit } = fixture();
    await workspace.init();
    const cached = workspace.active;
    const runtime = cached.runtimeId;
    disconnect.mockRejectedValueOnce(new Error('close failed'));
    await workspace.open('/b', '/b/other.jsonl');
    await workspace['poll']();
    expect(cached.connection).toBe('failed');
    expect(cached.runtimeId).toBe(runtime);
    const connect = vi.spyOn(api, 'connect');
    await workspace.activate(cached);
    expect(connect).not.toHaveBeenCalled();
    expect(cached.connection).toBe('ready');
    emit(runtime, [{ type: 'run', state: 'running' }]);
    await vi.waitFor(() => expect(cached.run).toBe('running'));
  });
  it('waits for background eviction to release the native session before reopening', async () => {
    const { workspace, api, disconnect } = fixture();
    await workspace.init();
    const evicted = workspace.active;
    let finishClose!: () => void;
    disconnect.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishClose = resolve;
        }),
    );
    for (let index = 1; index <= 6; index++)
      await workspace.open('/a', `/a/${index}.jsonl`);
    workspace.active.navigation!.changed();
    await vi.waitFor(() => expect(evicted.connection).toBe('stopping'));
    const connect = vi.spyOn(api, 'connect');
    const opening = workspace.activate(evicted);
    await Promise.resolve();
    expect(connect).not.toHaveBeenCalled();
    finishClose();
    await opening;
    expect(connect).toHaveBeenCalledTimes(1);
    expect(evicted.connection).toBe('ready');
    expect(workspace.active).toBe(evicted);
    expect(workspace.retained).toContain(evicted);
  });
  it('uses historical prompt previews when Pi sessions have no explicit name', async () => {
    const { workspace } = fixture();
    await workspace.init();
    const history = {
      ...summary('/a/one.jsonl', '/a'),
      name: '',
      preview: '修复登录接口',
    };
    workspace.active.sessions = [history];
    expect(
      workspace.sidebarSessions.find((entry) => entry.path === history.path)
        ?.name,
    ).toBe('修复登录接口');
    await workspace.open('/a', history.path);
    workspace.active.sessions = [history];
    workspace.active.snapshot.sessionName = '新会话';
    expect(
      workspace.sidebarSessions.find((entry) => entry.path === history.path)
        ?.name,
    ).toBe('修复登录接口');
    workspace.active.settings.sidebarItems = [
      { kind: 'session', path: history.path, name: '登录修复' },
    ];
    expect(
      workspace.sidebarSessions.find((entry) => entry.path === history.path)
        ?.name,
    ).toBe('登录修复');
  });
  it('restores a cancelled queued prompt without overwriting the new draft', async () => {
    const { workspace } = fixture();
    await workspace.init();
    const session = workspace.active;
    session.draft = 'first';
    await session.send();
    session.draft = 'next';
    await workspace.cancel(session);
    expect(session.draft).toBe('next');
    expect(session.recoveredImages[0].text).toBe('first');
    workspace.persist();
    expect(localStorage.getItem('pi-desktop-workspace-v1')).toContain('next');
  });
  it('recovers an accepted submission after a lost IPC response without resending', async () => {
    const { workspace, faults, tasks } = fixture();
    await workspace.init();
    faults.lostResponse = true;
    workspace.newDraft('/b');
    workspace.active.draft = 'only once';
    await workspace.active.send();
    expect(tasks).toHaveLength(1);
    expect(workspace.active.draft).toBe('');
  });
  it('keeps the unsent draft and interrupted input separately across restart without running either', async () => {
    const first = fixture();
    await first.workspace.init();
    first.workspace.active.draft = 'executing';
    await first.workspace.active.send();
    first.workspace.active.draft = 'next draft';
    first.workspace.persist();
    first.workspace.dispose();
    const second = fixture();
    await second.workspace.init();
    const restored = second.workspace.sessions.find(
      (session) => session.draft === 'next draft',
    );
    expect(restored?.recovered).toContain('executing');
    expect(second.tasks).toHaveLength(0);
  });
  it('replays a wakeup received while the new-session event pump is reading an empty batch', async () => {
    const { workspace, api, states } = fixture();
    await workspace.init();
    states.set('reserved-new', { sessionFile: '/b/new.jsonl', cwd: '/b' });
    let finishEmpty!: (batch: Awaited<ReturnType<Bridge['events']>>) => void;
    let wake!: (event: Wakeup) => void;
    let reads = 0;
    api.submitNew = async (
      project,
      _id,
      _action,
      _model,
      _thinking,
      receive,
    ) => {
      wake = receive;
      receive({
        type: 'initialized',
        runtimeId: 'reserved-new',
        project,
        snapshot: { sessionFile: '/b/new.jsonl', cwd: project },
      });
      return { desktopTask: 'new-task', runtimeId: 'reserved-new' };
    };
    api.events = async (runtimeId) => {
      reads++;
      if (reads === 1)
        return new Promise((resolve) => {
          finishEmpty = resolve;
        });
      return {
        runtimeId,
        sequence: 1,
        events:
          reads === 2
            ? [
                {
                  type: 'message' as const,
                  message: {
                    id: 'user-1',
                    role: 'user' as const,
                    text: 'hello',
                    thinking: '',
                    status: 'done' as const,
                    contentRef: null,
                    name: null,
                  },
                },
              ]
            : [],
      };
    };
    workspace.newDraft('/b');
    const session = workspace.active;
    session.draft = 'hello';
    await session.send();
    expect(reads).toBe(1);
    wake({ type: 'available', runtimeId: 'reserved-new' });
    finishEmpty({ runtimeId: 'reserved-new', sequence: 0, events: [] });
    await vi.waitFor(() => expect(session.messages[0]?.text).toBe('hello'));
    expect(workspace.active).toBe(session);
    expect(reads).toBeGreaterThanOrEqual(2);
  });
  it('shows an accepted first prompt before Pi initialization and replaces it without duplication', async () => {
    const { workspace, api, states, emit } = fixture();
    await workspace.init();
    let initialize!: () => void;
    api.submitNew = async (
      project,
      _id,
      _prompt,
      _model,
      _thinking,
      receive,
    ) => {
      // 模拟宿主立即接受任务、Pi 启动较慢，不依赖真实时间等待。
      const connected = await api.connect(project, receive);
      initialize = () =>
        receive({
          type: 'initialized',
          runtimeId: connected.runtimeId,
          project,
          snapshot: states.get(connected.runtimeId)!,
        });
      return { desktopTask: 'slow-task', runtimeId: connected.runtimeId };
    };
    workspace.newDraft('/b');
    const session = workspace.active;
    session.draft = '你好';
    await session.send();
    expect(session.newChatProject).toBeNull();
    expect(session.messages).toHaveLength(0);
    expect(session.transcriptMessages.map((message) => message.text)).toEqual([
      '你好',
    ]);
    initialize();
    expect(session.transcriptMessages).toHaveLength(1);
    emit(session.runtimeId, [
      {
        type: 'message',
        message: {
          id: 'official-user',
          role: 'user',
          text: '你好',
          thinking: '',
          status: 'done',
          contentRef: null,
          name: null,
        },
      },
    ]);
    await vi.waitFor(() => expect(session.messages).toHaveLength(1));
    expect(session.initialPending).toBeNull();
    expect(session.transcriptMessages.map((message) => message.id)).toEqual([
      'official-user',
    ]);
  });
  it('creates an independent process for a new project draft on first send', async () => {
    const { workspace, disconnect } = fixture();
    await workspace.init();
    const original = workspace.active;
    workspace.newDraft('/b');
    const draft = workspace.active;
    draft.draft = 'work';
    expect(draft.runtimeId).toBe('');
    await draft.send();
    expect(draft.runtimeId).not.toBe(original.runtimeId);
    expect(draft.project).toBe('/b');
    expect(draft.draft).toBe('');
    expect(disconnect).not.toHaveBeenCalled();
  });
  it('navigates local drafts and pre-file queued work, then binds a path without duplicating or changing identity', async () => {
    const { workspace, api, tasks } = fixture();
    await workspace.init();
    const connect = vi.spyOn(api, 'connect');
    api.submitNew = vi.fn(async () => {
      tasks.push({
        taskId: 'waiting',
        runtimeId: 'reserved-local',
        state: 'queued',
        position: 1,
      });
      return { desktopTask: 'waiting', runtimeId: 'reserved-local' };
    });
    workspace.newDraft('C:/Work');
    const local = workspace.active;
    local.draft = 'local queued input';
    const draftEntry = workspace.sidebarSessions.find(
      (entry) => entry.desktopId === local.desktopId,
    )!;
    expect(draftEntry).toMatchObject({ path: undefined, status: '草稿' });
    workspace.newDraft('/other');
    workspace.active.draft = 'other draft';
    await workspace.openEntry(draftEntry);
    expect(workspace.active).toBe(local);
    expect(local.draft).toBe('local queued input');
    expect(connect).not.toHaveBeenCalled();
    await local.send();
    expect(
      workspace.sidebarSessions.find((entry) => entry.id === draftEntry.id),
    ).toMatchObject({ path: undefined, status: '排队中' });
    workspace.newDraft('/other');
    await workspace.openEntry(draftEntry);
    expect(workspace.active).toBe(local);
    expect(connect).not.toHaveBeenCalled();
    const before = workspace.sidebarSessions.map((entry) => entry.id);
    local.snapshot = { sessionFile: 'C:/Sessions/One.jsonl' };
    local.newChatProject = null;
    local.connection = 'ready';
    const history = summary('c:/sessions/one.jsonl', 'c:/work');
    local.sessions = [
      history,
      summary(String.raw`\\?\C:\Sessions\One.jsonl`, 'C:/Work'),
    ];
    local.task = { ...local.task!, state: 'running', position: 0 };
    expect(workspace.sidebarSessions.map((entry) => entry.id)).toEqual(before);
    expect(
      workspace.sidebarSessions.filter(
        (entry) => entry.desktopId === local.desktopId,
      ),
    ).toHaveLength(1);
    expect(
      workspace.sidebarSessions.find((entry) => entry.id === draftEntry.id),
    ).toMatchObject({
      name: 'indexed title',
      path: 'C:/Sessions/One.jsonl',
      status: '运行中',
    });
    local.settings.pinnedSessions = ['c:/sessions/one.jsonl'];
    expect(workspace.pinnedSessions.map((entry) => entry.id)).toEqual([
      draftEntry.id,
    ]);
    expect(workspace.isPinned(workspace.pinnedSessions[0])).toBe(true);
    local.task = { ...local.task, state: 'completed' };
    local.unread = true;
    expect(
      workspace.sidebarSessions.find((entry) => entry.id === draftEntry.id),
    ).toMatchObject({ status: '已完成', unread: true });
    workspace.select(local);
    expect(
      workspace.sidebarSessions.find((entry) => entry.id === draftEntry.id),
    ).toMatchObject({ status: '已完成', unread: false });
    local.task = { ...local.task, state: 'failed' };
    local.error = 'failed';
    expect(
      workspace.sidebarSessions.find((entry) => entry.id === draftEntry.id)
        ?.status,
    ).toBe('失败');
    expect(workspace.sidebarSessions.map((entry) => entry.id)).toEqual(before);
  });
  it('upgrades legacy local recovery with a stable identity and opens it without starting Pi', async () => {
    localStorage.setItem(
      'pi-desktop-workspace-v1',
      JSON.stringify({
        version: 1,
        drafts: [
          {
            project: '/restored',
            text: 'saved draft',
            pendingText: 'interrupted input',
            interrupted: true,
          },
        ],
      }),
    );
    const first = fixture();
    await first.workspace.init();
    const entry = first.workspace.sidebarSessions.find(
      (entry) => entry.cwd === '/restored',
    )!;
    expect(entry).toMatchObject({ path: undefined, status: '待恢复' });
    const connect = vi.spyOn(first.api, 'connect');
    await first.workspace.openEntry(entry);
    expect(first.workspace.active.draft).toBe('saved draft');
    expect(first.workspace.active.recovered).toContain('interrupted input');
    expect(connect).not.toHaveBeenCalled();
    first.workspace.dispose();
    const stored = JSON.parse(localStorage.getItem('pi-desktop-workspace-v1')!);
    expect(stored.drafts[0].desktopId).toBe(entry.id);
    const second = fixture();
    await second.workspace.init();
    expect(
      second.workspace.sidebarSessions.find((item) => item.cwd === '/restored')
        ?.id,
    ).toBe(entry.id);
    expect(second.tasks).toHaveLength(0);
  });
  it.each(['project', 'session'] as const)(
    'keeps archived %s work reachable until execution and requests finish',
    async (kind) => {
      const { workspace } = fixture();
      await workspace.init();
      await workspace.open('/a', '/a/one.jsonl');
      const session = workspace.active;
      session.draft = 'archived work';
      await session.send();
      session.settings.sidebarItems = [
        {
          kind,
          path: kind === 'project' ? '/a' : '/a/one.jsonl',
          state: 'archived',
        },
      ];
      workspace.newDraft('/other');
      const find = () =>
        workspace.sidebarSessions.find(
          (entry) => entry.desktopId === session.desktopId,
        );
      expect(find()).toMatchObject({ archived: true, status: '排队中' });
      expect(workspace.projects.some((project) => project.path === '/a')).toBe(
        true,
      );
      session.task = { ...session.task!, state: 'completed' };
      session.extensions = [
        { id: 'confirm', type: 'extension_ui_request', method: 'confirm' },
      ];
      expect(find()).toMatchObject({ archived: true, status: '待你处理' });
      session.extensions = [];
      expect(find()).toBeUndefined();
      if (kind === 'project')
        expect(
          workspace.projects.some((project) => project.path === '/a'),
        ).toBe(false);
    },
  );
});
