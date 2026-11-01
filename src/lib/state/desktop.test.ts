/** 门面测试使用可替换 IPC 端口，验证失败保留草稿、取消切换和一次性扩展响应。 */
import { describe, it, expect, vi } from 'vitest';
import { Desktop } from './desktop.svelte';
import { defaultSettings } from '../types';
import { bridge, type Bridge } from '../client';
/** 只替换 action；其余桥接函数不应在这些独立场景中被触发。 */
function fixture(action: Bridge['action']) {
  return new Desktop({ ...bridge, action });
}
describe('desktop business behavior', () => {
  it('serializes older pages, deduplicates IDs and captures the anchor at commit', async () => {
    let release!: (page: unknown) => void;
    const action = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const desktop = fixture(action);
    const message = {
      id: 'current',
      role: 'assistant',
      text: '正文',
      thinking: '',
      contentRef: null,
      status: 'done',
      name: null,
    };
    desktop.messages = [message];
    desktop.before = 50;
    const capture = vi.fn(() =>
      expect(desktop.messages.map((m) => m.id)).toEqual(['current']),
    );
    const pending = desktop.refreshHistory(50, capture);
    await desktop.refreshHistory(50, capture);
    expect(action).toHaveBeenCalledOnce();
    expect(capture).not.toHaveBeenCalled();
    release({
      messages: [
        { ...message, id: 'older' },
        message,
        { ...message, id: 'older' },
      ],
      before: 0,
      hasMore: false,
    });
    await pending;
    expect(capture).toHaveBeenCalledOnce();
    expect(desktop.messages.map((m) => m.id)).toEqual(['older', 'current']);
    expect(desktop.loadingHistory).toBe(false);
  });
  it('ignores a late history response after switching sessions and rejects stalled cursors', async () => {
    let release!: (page: unknown) => void;
    const action = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const desktop = fixture(action);
    desktop.snapshot = { sessionFile: 'a' };
    const capture = vi.fn();
    const pending = desktop.refreshHistory(50, capture);
    desktop.snapshot = { sessionFile: 'b' };
    release({ messages: [], before: 0, hasMore: false });
    await pending;
    expect(capture).not.toHaveBeenCalled();
    expect(desktop.messages).toHaveLength(0);
    expect(desktop.loadingHistory).toBe(false);
    const stalled = desktop.refreshHistory(50, capture);
    release({ messages: [], before: 50, hasMore: true });
    await expect(stalled).rejects.toThrow('游标未前进');
    expect(capture).not.toHaveBeenCalled();
    expect(desktop.loadingHistory).toBe(false);
  });
  it('persists sidebar names, archive and trash states and restores original catalog items', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const desktop = new Desktop({ ...bridge, save });
    desktop.sessions = [
      { path: 'a', cwd: 'C:/alpha', name: 'Original', timestamp: '' },
      { path: 'b', cwd: 'C:/beta', name: 'Beta', timestamp: '' },
    ] as typeof desktop.sessions;
    desktop.settings.pinnedSessions = ['a'];
    await desktop.manageSidebar('session', 'a', { name: 'Renamed' });
    expect(desktop.recentSessions.find((s) => s.path === 'a')?.name).toBe(
      'Renamed',
    );
    expect(desktop.sessions[0].name).toBe('Original');
    await desktop.manageSidebar('project', 'c:\\alpha', {
      name: 'Project alias',
      state: 'archived',
    });
    expect(desktop.projectName('C:/alpha')).toBe('Project alias');
    expect(desktop.pinnedSessions).toHaveLength(0);
    expect(desktop.projects.map((p) => p.path)).toEqual(['C:/beta']);
    await desktop.manageSidebar('project', 'C:/alpha', { state: undefined });
    expect(desktop.pinnedSessions[0].name).toBe('Renamed');
    await desktop.manageSidebar('session', 'a', { state: 'deleted' });
    expect(desktop.recentSessions.map((s) => s.path)).toEqual(['b']);
    await desktop.manageSidebar('session', 'a', { state: undefined });
    expect(desktop.pinnedSessions[0].name).toBe('Renamed');
    save.mockRejectedValueOnce(new Error('disk full'));
    await expect(
      desktop.manageSidebar('session', 'a', { state: 'deleted' }),
    ).rejects.toThrow('disk full');
    expect(desktop.pinnedSessions).toHaveLength(1);
    expect(desktop.sidebarSaving).toBe(false);
  });
  it('includes legacy trash in archives and normalizes it only after a successful save', async () => {
    const save = vi
      .fn()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValue(undefined);
    const desktop = new Desktop({ ...bridge, save });
    desktop.settings.sidebarItems = [
      { kind: 'project', path: '/old', state: 'deleted', name: '旧记录' },
      { kind: 'session', path: 'a', state: 'archived' },
    ];
    expect(desktop.archivedItems).toHaveLength(2);
    await expect(
      desktop.manageSidebar('session', 'a', { state: undefined }),
    ).rejects.toThrow('disk full');
    expect(desktop.sidebarItem('project', '/old')?.state).toBe('deleted');
    await desktop.manageSidebar('session', 'a', { state: undefined });
    expect(desktop.sidebarItem('project', '/old')?.state).toBe('archived');
    expect(desktop.archivedItems).toHaveLength(1);
    await desktop.manageSidebar('project', '/old', { state: undefined });
    await desktop.undoSidebar();
    expect(desktop.sidebarItem('project', '/old')?.state).toBe('archived');
  });
  it('undoes lifecycle transitions without changing the active session, draft or messages', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const desktop = new Desktop({ ...bridge, save });
    desktop.project = '/alpha';
    desktop.snapshot = { sessionFile: 'a' };
    desktop.draft = '正在编辑的内容';
    const original = desktop.messages;
    await desktop.manageSidebar('session', 'a', { state: 'archived' });
    await desktop.manageSidebar('session', 'a', { state: 'deleted' });
    await desktop.undoSidebar();
    expect(desktop.sidebarItem('session', 'a')?.state).toBe('archived');
    expect(desktop.sidebarUndo).toBeNull();
    await desktop.manageSidebar('session', 'a', { state: undefined });
    save.mockRejectedValueOnce(new Error('disk full'));
    await expect(desktop.undoSidebar()).rejects.toThrow('disk full');
    expect(desktop.sidebarItem('session', 'a')?.state).toBeUndefined();
    expect(desktop.sidebarUndo?.state).toBe('archived');
    await desktop.undoSidebar();
    expect(desktop.sidebarItem('session', 'a')?.state).toBe('archived');
    expect(desktop.snapshot.sessionFile).toBe('a');
    expect(desktop.newChatProject).toBeNull();
    expect(desktop.draft).toBe('正在编辑的内容');
    expect(desktop.messages).toBe(original);
  });
  it('prepares project drafts locally and creates exactly once on the first send', async () => {
    const action = vi.fn().mockImplementation(async (_runtime, command) => {
      if (command.type === 'state')
        return { cwd: 'beta', sessionFile: 'new.jsonl' };
      if (command.type === 'history')
        return { messages: [], before: 0, hasMore: false };
      return { cancelled: false };
    });
    const connect = vi.fn();
    const desktop = new Desktop({
      ...bridge,
      action,
      connect,
      save: vi.fn().mockResolvedValue(undefined),
      sessions: async () => [],
      events: async () => ({ runtimeId: 'r', sequence: 0, events: [] }),
    });
    desktop.connection = 'ready';
    desktop.runtimeId = 'r';
    desktop.project = 'alpha';
    desktop.snapshot = { cwd: 'alpha', sessionFile: 'old.jsonl' };
    desktop.draft = '原会话草稿';
    desktop.prepareNewChat('beta');
    expect(desktop.draft).toBe('');
    desktop.draft = '首条消息';
    desktop.prepareNewChat('gamma', true);
    desktop.prepareNewChat('beta', true);
    expect(action).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    expect(desktop.snapshot.sessionFile).toBe('old.jsonl');
    await desktop.send();
    expect(
      action.mock.calls.filter(
        ([, command]) => command.type === 'new_project_session',
      ),
    ).toEqual([['r', { type: 'new_project_session', project: 'beta' }]]);
    expect(action).toHaveBeenCalledWith('r', {
      type: 'prompt',
      message: '首条消息',
      mode: undefined,
    });
    expect(desktop.newChatProject).toBeNull();
    expect(desktop.draft).toBe('');
    expect(desktop.project).toBe('beta');
    expect(connect).not.toHaveBeenCalled();
  });
  it.each([
    [
      '/workspace/project',
      '/sessions/original.jsonl',
      '/sessions/original.jsonl',
    ],
    [
      'C:/work/project',
      '\\\\?\\C:\\sessions\\original.jsonl',
      'c:/SESSIONS/ORIGINAL.jsonl',
    ],
  ])(
    'returns from a local new-chat draft without invoking switch hooks (%s)',
    async (project, activePath, targetPath) => {
      const action = vi.fn().mockResolvedValue({ cancelled: true });
      const desktop = fixture(action);
      desktop.connection = 'ready';
      desktop.project = project;
      desktop.snapshot = { sessionFile: activePath };
      desktop.draft = '原会话草稿';
      desktop.toggleTool('tool', 'output');
      const messages = desktop.messages;
      desktop.prepareNewChat('another-project');
      desktop.draft = '新对话草稿';
      await desktop.openSession(project, targetPath);
      expect(action).not.toHaveBeenCalled();
      expect(desktop.newChatProject).toBeNull();
      expect(desktop.openingSession).toBeNull();
      expect(desktop.draft).toBe('原会话草稿');
      expect(desktop.messages).toBe(messages);
      expect(desktop.toolViews.tool.output).toBe(true);
      desktop.prepareNewChat('another-project');
      expect(desktop.draft).toBe('新对话草稿');
    },
  );
  it('keeps a new-chat draft without sending into the old session when creation is cancelled or fails', async () => {
    const action = vi.fn().mockResolvedValue({ cancelled: true });
    const desktop = fixture(action);
    desktop.connection = 'ready';
    desktop.project = 'alpha';
    desktop.prepareNewChat('beta');
    desktop.draft = '保留首条消息';
    await desktop.send();
    expect(desktop.newChatProject).toBe('beta');
    expect(desktop.draft).toBe('保留首条消息');
    action.mockRejectedValueOnce(new Error('failed'));
    await expect(desktop.send()).rejects.toThrow('failed');
    expect(desktop.newChatProject).toBe('beta');
    expect(desktop.draft).toBe('保留首条消息');
    expect(
      action.mock.calls.every(
        ([, command]) => command.type === 'new_project_session',
      ),
    ).toBe(true);
  });
  it('cancels pending and newly arriving plan dialogs during stop', async () => {
    let finish!: (value: unknown) => void;
    const action = vi.fn().mockImplementation(async (_runtime, command) => {
      if (command.type === 'stop')
        return new Promise((resolve) => {
          finish = resolve;
        });
      return command.type === 'state' ? { isStreaming: false } : {};
    });
    const desktop = fixture(action);
    desktop.connection = 'ready';
    desktop.run = 'running';
    desktop.extensions = [
      { type: 'extension_ui_request', id: 'first', method: 'select' },
    ];
    const stopping = desktop.stop();
    await vi.waitFor(() =>
      expect(action).toHaveBeenCalledWith('', { type: 'stop' }),
    );
    // 使用事件处理入口模拟 abort 的 agent_end 钩子新建对话框。
    (desktop as any).extension({ id: 'late', method: 'select' });
    await vi.waitFor(() =>
      expect(action).toHaveBeenCalledWith('', {
        type: 'extension_response',
        id: 'late',
        value: { cancelled: true },
      }),
    );
    expect(action).toHaveBeenCalledWith('', {
      type: 'extension_response',
      id: 'first',
      value: { cancelled: true },
    });
    expect(desktop.extensions).toHaveLength(0);
    finish({});
    await stopping;
    expect(desktop.run).toBe('idle');
  });
  it.each([false, true])(
    'reconciles authoritative state after stop timeout (streaming=%s)',
    async (streaming) => {
      vi.useFakeTimers();
      try {
        const action = vi.fn().mockImplementation(async (_runtime, command) => {
          if (command.type === 'stop') throw new Error('timeout');
          return { isStreaming: streaming };
        });
        const desktop = fixture(action);
        desktop.connection = 'ready';
        desktop.draft = 'keep';
        await expect(desktop.stop()).rejects.toThrow('timeout');
        expect(desktop.run).toBe(streaming ? 'aborting' : 'idle');
        expect(desktop.draft).toBe('keep');
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );
  it('cleans extension status and widget text without changing select values', () => {
    const desktop = fixture(vi.fn());
    const colored = '\x1b[38;2;205;154;34m⏸ plan\x1b[39m';
    (desktop as any).extension({
      method: 'setStatus',
      statusKey: 'plan',
      statusText: colored,
    });
    (desktop as any).extension({
      method: 'setWidget',
      widgetKey: 'plan',
      widgetLines: [colored],
    });
    (desktop as any).extension({
      id: 'choice',
      method: 'select',
      title: colored,
      options: [colored],
    });
    expect(desktop.statuses.plan).toBe('⏸ plan');
    expect(desktop.widgets.plan).toEqual(['⏸ plan']);
    expect(desktop.extensions[0].title).toBe('⏸ plan');
    expect(desktop.extensions[0].options).toEqual([colored]);
  });
  it('handles builtin commands locally and never sends them as prompts or steering', async () => {
    const action = vi.fn().mockResolvedValue({});
    const desktop = fixture(action);
    desktop.connection = 'ready';
    desktop.draft = '/name focus on tests';
    await desktop.send();
    expect(desktop.builtinRequest).toEqual({
      name: 'name',
      args: 'focus on tests',
    });
    expect(desktop.draft).toBe('');
    expect(action).not.toHaveBeenCalled();
    desktop.run = 'running';
    desktop.draft = '/new';
    await expect(desktop.send('followUp')).rejects.toThrow('请等待');
    expect(desktop.draft).toBe('/new');
    expect(desktop.messages).toHaveLength(0);
    expect(action).not.toHaveBeenCalled();
    desktop.draft = '/skill:review code';
    await desktop.send();
    expect(action).toHaveBeenCalledWith('', {
      type: 'prompt',
      message: '/skill:review code',
      mode: 'steer',
    });
  });
  it('compacts directly without a dialog or prompt and settles without agent_settled', async () => {
    const action = vi.fn().mockResolvedValue({});
    const desktop = fixture(action);
    desktop.connection = 'ready';
    desktop.draft = '/compact 保留代码';
    vi.spyOn(desktop, 'refreshCommandSession').mockResolvedValue();
    vi.spyOn(desktop, 'syncState').mockResolvedValue();
    await desktop.send();
    expect(action).toHaveBeenCalledWith('', {
      type: 'compact',
      instructions: '保留代码',
    });
    expect(desktop.builtinRequest).toBeNull();
    expect(desktop.run).toBe('idle');
    expect(desktop.submitting).toBe(false);
    expect(desktop.draft).toBe('');
  });
  it('retains the compact command and clears busy state when compaction fails', async () => {
    const action = vi.fn().mockRejectedValue(new Error('compact failed'));
    const desktop = fixture(action);
    desktop.connection = 'ready';
    desktop.draft = '/compact';
    vi.spyOn(desktop, 'syncState').mockResolvedValue();
    await expect(desktop.send()).rejects.toThrow('compact failed');
    expect(desktop.draft).toBe('/compact');
    expect(desktop.run).toBe('idle');
    expect(desktop.submitting).toBe(false);
  });
  it('defaults running messages to steering and retains edited drafts and failure drafts', async () => {
    let finish!: (result: unknown) => void;
    const action = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const desktop = fixture(action);
    desktop.connection = 'ready';
    desktop.run = 'running';
    desktop.draft = '调整方向';
    const pending = desktop.send();
    expect(action).toHaveBeenCalledWith('', {
      type: 'prompt',
      message: '调整方向',
      mode: 'steer',
    });
    expect(desktop.messages[0].delivery?.state).toBe('sending');
    desktop.draft = '下一条草稿';
    await desktop.send();
    expect(action).toHaveBeenCalledTimes(1);
    finish({});
    await pending;
    expect(desktop.draft).toBe('下一条草稿');
    expect(desktop.notice).toBe('引导消息已提交');
    expect(desktop.messages[0].delivery?.state).toBe('queued');
    action.mockRejectedValueOnce(new Error('queue rejected'));
    await expect(desktop.send('followUp')).rejects.toThrow('queue rejected');
    expect(desktop.draft).toBe('下一条草稿');
    expect(desktop.submitting).toBe(false);
    expect(desktop.messages).toHaveLength(1);
    action.mockResolvedValueOnce({});
    await desktop.send('followUp');
    expect(desktop.draft).toBe('');
    expect(action).toHaveBeenLastCalledWith('', {
      type: 'prompt',
      message: '下一条草稿',
      mode: 'followUp',
    });
  });
  it('isolates tool expansion and rejects content responses from an earlier session or runtime', async () => {
    let finish!: (page: { text: string; next: number; done: boolean }) => void;
    const content = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const desktop = new Desktop({ ...bridge, content });
    desktop.runtimeId = 'runtime-a';
    desktop.snapshot = { sessionFile: 'a.jsonl' };
    desktop.toggleTool('t', 'output');
    desktop.toggleTool('t', 'args');
    expect(desktop.toolViews.t).toEqual({ output: true, args: true });
    desktop.toggleTool('t', 'output');
    expect(desktop.toolViews.t.output).toBe(false);
    const pending = desktop.readContent('body', 0);
    desktop.snapshot = { sessionFile: 'b.jsonl' };
    finish({ text: 'stale', next: 5, done: true });
    await expect(pending).rejects.toThrow('会话已切换');
    const restarted = desktop.readContent('body', 0);
    desktop.runtimeId = 'runtime-b';
    finish({ text: 'stale', next: 5, done: true });
    await expect(restarted).rejects.toThrow('会话已切换');
  });
  it('keeps the opened title after Windows path normalization and index refresh, then resets it for a new session', async () => {
    let sessionFile = 'C:\\sessions\\original.jsonl';
    const action: Bridge['action'] = async <T>(
      _: string,
      command: Parameters<Bridge['action']>[1],
    ) => {
      if (command.type === 'switch_session')
        sessionFile = '\\\\?\\C:\\SESSIONS\\TARGET.JSONL';
      if (command.type === 'new_session')
        sessionFile = 'C:\\sessions\\new.jsonl';
      return (
        command.type === 'state'
          ? { sessionFile }
          : command.type === 'history'
            ? { messages: [], before: 0, hasMore: false }
            : { cancelled: false }
      ) as T;
    };
    const desktop = new Desktop({
      ...bridge,
      action,
      events: async () => ({ runtimeId: 'r', sequence: 0, events: [] }),
      sessions: async () => [],
    });
    desktop.project = 'project';
    desktop.runtimeId = 'r';
    desktop.connection = 'ready';
    desktop.sessions = [
      {
        path: 'C:/sessions/target.jsonl',
        id: 'target',
        cwd: 'project',
        name: '当前会话名称',
        preview: '',
        timestamp: '',
        modified: 0,
        warning: null,
      },
    ];
    desktop.snapshot = { sessionFile: '\\\\?\\C:\\SESSIONS\\TARGET.JSONL' };
    expect(desktop.sessionTitle).toBe('当前会话名称');
    await desktop.openSession('project', 'C:/sessions/target.jsonl');
    expect(desktop.openingSession).toBeNull();
    expect(desktop.sessions).toEqual([]);
    expect(desktop.sessionTitle).toBe('当前会话名称');
    await desktop.syncState();
    expect(desktop.sessionTitle).toBe('当前会话名称');
    await desktop.rename('新的会话名称');
    expect(desktop.sessionTitle).toBe('新的会话名称');
    desktop.toggleTool('tool', 'output');
    await desktop.newSession();
    expect(desktop.toolViews).toEqual({});
    expect(desktop.sessionTitle).toBe('新对话');
  });
  it('previews the target title while loading and restores the original title on cancellation or failure', async () => {
    let finish!: (result: { cancelled: boolean }) => void;
    const action = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const desktop = fixture(action);
    desktop.project = 'project';
    desktop.connection = 'ready';
    desktop.snapshot = { sessionFile: 'original' };
    desktop.sessions = ['original', 'target'].map((path) => ({
      path,
      id: path,
      cwd: 'project',
      name: path === 'original' ? '原会话' : '目标会话',
      preview: '',
      timestamp: '',
      modified: 0,
      warning: null,
    }));
    desktop.draft = 'keep draft';
    const pending = desktop.openSession('project', 'target');
    expect(desktop.sessionTitle).toBe('目标会话');
    expect(desktop.openingSession?.path).toBe('target');
    await desktop.send();
    await desktop.openSession('project', 'another');
    expect(action).toHaveBeenCalledTimes(1);
    finish({ cancelled: true });
    await pending;
    expect(desktop.openingSession).toBeNull();
    expect(desktop.sessionTitle).toBe('原会话');
    expect(desktop.draft).toBe('keep draft');
    action.mockRejectedValueOnce(new Error('read failed'));
    await expect(desktop.openSession('project', 'target')).rejects.toThrow(
      'read failed',
    );
    expect(desktop.openingSession).toBeNull();
    expect(desktop.sessionTitle).toBe('原会话');
    desktop.snapshot.sessionName = '重命名后的会话';
    expect(desktop.sessionTitle).toBe('重命名后的会话');
  });
  it('keeps new-session loading active through connection and history and ignores repeated switches', async () => {
    let finishConnection!: (
      value: Awaited<ReturnType<Bridge['connect']>>,
    ) => void;
    let finishHistory!: () => void;
    const connect = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          finishConnection = resolve;
        }),
    );
    const desktop = new Desktop({
      ...bridge,
      connect,
      save: vi.fn().mockResolvedValue(undefined),
    });
    vi.spyOn(desktop, 'refreshMetadata').mockResolvedValue();
    vi.spyOn(desktop, 'refreshSessions').mockResolvedValue();
    vi.spyOn(desktop, 'refreshHistory').mockImplementation(
      () =>
        new Promise((resolve) => {
          finishHistory = resolve;
        }),
    );
    desktop.project = 'alpha';
    desktop.snapshot = { sessionName: '旧会话' };
    const creating = desktop.newSession('beta');
    expect(desktop.sessionTitle).toBe('新对话');
    expect(desktop.openingSession).not.toBeNull();
    await desktop.newSession('gamma');
    await desktop.openSession('alpha', 'old.jsonl');
    expect(connect).toHaveBeenCalledOnce();
    finishConnection({
      runtimeId: 'new-runtime',
      project: 'beta',
      snapshot: {},
      version: '1.4.0',
      verified: true,
    });
    await vi.waitFor(() => expect(finishHistory).toBeTypeOf('function'));
    expect(desktop.openingSession).not.toBeNull();
    finishHistory();
    await creating;
    expect(desktop.openingSession).toBeNull();
    expect(desktop.project).toBe('beta');
  });
  it('loads a cross-project new session while recent-project settings are still being saved', async () => {
    let finishSave!: () => void;
    const save = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishSave = resolve;
        }),
    );
    const desktop = new Desktop({
      ...bridge,
      connect: vi.fn().mockResolvedValue({
        runtimeId: 'beta-runtime',
        project: 'beta',
        snapshot: {},
        version: '1.4.0',
        verified: true,
      }),
      save,
    });
    const metadata = vi.spyOn(desktop, 'refreshMetadata').mockResolvedValue();
    const history = vi.spyOn(desktop, 'refreshHistory').mockResolvedValue();
    const sessions = vi.spyOn(desktop, 'refreshSessions').mockResolvedValue();
    desktop.project = 'alpha';
    const creating = desktop.newSession('beta');
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(metadata).toHaveBeenCalledOnce();
    expect(history).toHaveBeenCalledOnce();
    expect(sessions).toHaveBeenCalledOnce();
    expect(desktop.openingSession).not.toBeNull();
    finishSave();
    await creating;
    expect(desktop.openingSession).toBeNull();
    expect(desktop.project).toBe('beta');
  });
  it('releases new-session loading and preserves the old conversation on cancellation or failure', async () => {
    const action = vi.fn().mockResolvedValue({ cancelled: true });
    const desktop = fixture(action);
    desktop.connection = 'ready';
    desktop.project = 'alpha';
    desktop.snapshot = { sessionName: '旧会话' };
    desktop.draft = '保留草稿';
    await desktop.newSession('beta');
    expect(action).toHaveBeenCalledWith('', {
      type: 'new_project_session',
      project: 'beta',
    });
    expect(desktop.project).toBe('alpha');
    expect(desktop.openingSession).toBeNull();
    expect(desktop.sessionTitle).toBe('旧会话');
    expect(desktop.draft).toBe('保留草稿');
    action.mockRejectedValueOnce(new Error('new failed'));
    await expect(desktop.newSession('beta')).rejects.toThrow('new failed');
    expect(desktop.openingSession).toBeNull();
    expect(desktop.sessionTitle).toBe('旧会话');
    expect(desktop.draft).toBe('保留草稿');
  });
  it('reuses the runtime when creating a blank session in another project', async () => {
    const action = vi.fn().mockResolvedValue({ cancelled: false });
    const connect = vi.fn();
    const desktop = new Desktop({
      ...bridge,
      action,
      connect,
      save: vi.fn().mockResolvedValue(undefined),
    });
    desktop.connection = 'ready';
    desktop.runtimeId = 'existing-runtime';
    desktop.project = 'alpha';
    desktop.snapshot = { sessionFile: 'old.jsonl', cwd: 'alpha' };
    desktop.draft = 'alpha draft';
    vi.spyOn(desktop, 'syncState').mockImplementation(async () => {
      desktop.snapshot = { sessionFile: 'blank.jsonl', cwd: 'beta' };
    });
    vi.spyOn(desktop as any, 'drain').mockResolvedValue(undefined);
    vi.spyOn(desktop, 'refreshHistory').mockImplementation(async () => {
      desktop.messages = [];
    });
    vi.spyOn(desktop, 'refreshMetadata').mockResolvedValue();
    vi.spyOn(desktop, 'refreshSessions').mockResolvedValue();
    await desktop.newSession('beta');
    expect(connect).not.toHaveBeenCalled();
    expect(action).toHaveBeenCalledWith('existing-runtime', {
      type: 'new_project_session',
      project: 'beta',
    });
    expect(desktop.runtimeId).toBe('existing-runtime');
    expect(desktop.project).toBe('beta');
    expect(desktop.draft).toBe('');
    expect(desktop.sessionTitle).toBe('新对话');
  });
  it('uses the host-resolved home directory for a new conversation without a project', async () => {
    const connect = vi.fn().mockResolvedValue({
      runtimeId: 'home',
      project: 'C:/Users/mock',
      snapshot: {},
      version: '1.4.0',
      verified: true,
    });
    const save = vi.fn().mockResolvedValue(undefined);
    const desktop = new Desktop({ ...bridge, connect, save });
    vi.spyOn(desktop, 'refreshMetadata').mockResolvedValue();
    vi.spyOn(desktop, 'refreshHistory').mockResolvedValue();
    vi.spyOn(desktop, 'refreshSessions').mockResolvedValue();
    await desktop.newSession();
    expect(connect).toHaveBeenCalledWith('', expect.any(Function));
    expect(desktop.project).toBe('C:/Users/mock');
    expect(desktop.connection).toBe('ready');
    expect(desktop.settings.recentProjects).toEqual(['C:/Users/mock']);
    expect(desktop.isExpanded('C:/Users/mock')).toBe(true);
  });
  it('persists pin changes and retains previous pins on save failure', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const desktop = new Desktop({ ...bridge, save });
    await desktop.togglePin('one.jsonl');
    expect(desktop.isPinned('one.jsonl')).toBe(true);
    expect(save).toHaveBeenLastCalledWith(
      expect.objectContaining({ pinnedSessions: ['one.jsonl'] }),
    );
    save.mockRejectedValueOnce(new Error('disk full'));
    await expect(desktop.togglePin('one.jsonl')).rejects.toThrow('disk full');
    expect(desktop.isPinned('one.jsonl')).toBe(true);
    expect(desktop.pinSaving).toBe(false);
    await desktop.togglePin('one.jsonl');
    expect(desktop.isPinned('one.jsonl')).toBe(false);
  });
  it('keeps project order stable across active-project changes and catalog activity updates', () => {
    const desktop = fixture(vi.fn());
    desktop.sessions = [
      { cwd: 'C:/work/beta', path: 'b' },
      { cwd: 'C:/work/alpha', path: 'a' },
    ] as typeof desktop.sessions;
    desktop.settings.recentProjects = ['C:/work/empty', 'C:/work/beta'];
    const order = desktop.projects.map((project) => project.path);
    desktop.project = 'C:/work/beta';
    desktop.settings.recentProjects.reverse();
    desktop.sessions.reverse();
    expect(desktop.projects.map((project) => project.path)).toEqual(order);
    desktop.project = 'C:/work/alpha';
    expect(desktop.projects.map((project) => project.path)).toEqual(order);
  });
  it('discovers all workspaces, prewarms Pi and groups Windows aliases', async () => {
    const sessions = vi.fn().mockResolvedValue([
      { cwd: 'C:/work/alpha', path: 'a' },
      { cwd: 'c:\\work\\ALPHA', path: 'b' },
      { cwd: 'C:/work/beta', path: 'c' },
    ]);
    const connect = vi.fn().mockResolvedValue({
      runtimeId: 'warm',
      project: 'C:/work/empty',
      snapshot: {},
      version: '1.4.0',
      verified: true,
    });
    const desktop = new Desktop({
      ...bridge,
      settings: async () => ({
        ...defaultSettings,
        recentProjects: ['C:/work/empty'],
      }),
      sessions,
      connect,
      save: vi.fn().mockResolvedValue(undefined),
    });
    vi.spyOn(desktop, 'refreshMetadata').mockResolvedValue();
    vi.spyOn(desktop, 'refreshHistory').mockResolvedValue();
    await desktop.init();
    expect(sessions).toHaveBeenCalledWith('', '');
    expect(connect).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledWith('C:/work/empty', expect.any(Function));
    expect(desktop.projects.map((p) => p.sessions.length)).toEqual([2, 1, 0]);
    desktop.toggleProject('C:/work/alpha');
    expect(desktop.isExpanded('c:/work/ALPHA')).toBe(true);
    desktop.toggleProject('c:/work/ALPHA');
    expect(desktop.isExpanded('C:/work/alpha')).toBe(false);
  });
  it('reuses the Pi process when restoring a session in another workspace', async () => {
    const desktop = fixture(vi.fn());
    desktop.project = 'old-project';
    desktop.connection = 'ready';
    const order: string[] = [];
    vi.spyOn(desktop, 'connect').mockImplementation(async (project) => {
      order.push(`connect:${project}`);
      desktop.project = project;
      desktop.connection = 'ready';
    });
    vi.spyOn(desktop, 'switchSession').mockImplementation(async (path) => {
      order.push(`session:${path}`);
    });
    await desktop.openSession('other-project', 'history.jsonl');
    expect(order).toEqual(['session:history.jsonl']);
    expect(desktop.switchSession).toHaveBeenCalledWith(
      'history.jsonl',
      'other-project',
    );
  });
  it('keeps sessions in creation order when catalog order, names and activity change', () => {
    const desktop = fixture(vi.fn());
    desktop.sessions = [
      { cwd: 'project', path: 'older', timestamp: '2026-01-01', modified: 9 },
      { cwd: 'project', path: 'newer-b', timestamp: '2026-02-01', modified: 1 },
      { cwd: 'project', path: 'newer-a', timestamp: '2026-02-01', modified: 2 },
    ] as typeof desktop.sessions;
    const order = () => desktop.projects[0].sessions.map((item) => item.path);
    expect(order()).toEqual(['newer-a', 'newer-b', 'older']);
    desktop.sessions.reverse();
    desktop.sessions[0].modified = 100;
    desktop.sessions[0].name = 'renamed';
    expect(order()).toEqual(['newer-a', 'newer-b', 'older']);
  });
  it('only promotes a conversation after a successful send in both lists', async () => {
    const action = vi.fn().mockResolvedValue({});
    const desktop = fixture(action);
    desktop.connection = 'ready';
    desktop.project = 'project';
    desktop.snapshot = { sessionFile: 'older' };
    desktop.sessions = [
      {
        cwd: 'project',
        path: 'older',
        timestamp: '2025-01-01',
        lastPromptAt: '2026-01-01T00:00:00.000Z',
        modified: 100,
      },
      {
        cwd: 'project',
        path: 'newer',
        timestamp: '2025-02-01',
        lastPromptAt: '2026-02-01T00:00:00.000Z',
        modified: 1,
      },
    ] as typeof desktop.sessions;
    const recentOrder = () => desktop.recentSessions.map((item) => item.path);
    const projectOrder = () =>
      desktop.projects[0].sessions.map((item) => item.path);
    expect(recentOrder()).toEqual(['newer', 'older']);
    expect(projectOrder()).toEqual(recentOrder());
    desktop.sessions.reverse();
    desktop.sessions[1].name = 'renamed';
    desktop.sessions[1].modified = 999;
    expect(projectOrder()).toEqual(['newer', 'older']);
    desktop.draft = 'next';
    action.mockRejectedValueOnce(new Error('rejected'));
    await expect(desktop.send()).rejects.toThrow('rejected');
    expect(recentOrder()).toEqual(['newer', 'older']);
    await desktop.send();
    expect(recentOrder()).toEqual(['older', 'newer']);
    expect(projectOrder()).toEqual(recentOrder());
  });
  it('persists project moves across path aliases and leaves order intact on save failure', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const desktop = new Desktop({ ...bridge, save });
    desktop.sessions = ['alpha', 'beta', 'gamma'].map((name) => ({
      cwd: `C:/work/${name}`,
      path: name,
    })) as typeof desktop.sessions;
    const order = () => desktop.projects.map((item) => item.path);
    await desktop.moveProject('c:\\work\\GAMMA', 'C:/work/alpha');
    expect(order()).toEqual(['C:/work/gamma', 'C:/work/alpha', 'C:/work/beta']);
    expect(save).toHaveBeenLastCalledWith(
      expect.objectContaining({ projectOrder: order() }),
    );
    desktop.sessions.reverse();
    desktop.project = 'C:/work/beta';
    expect(order()).toEqual(['C:/work/gamma', 'C:/work/alpha', 'C:/work/beta']);
    save.mockRejectedValueOnce(new Error('disk full'));
    await expect(
      desktop.moveProject('C:/work/beta', 'C:/work/gamma'),
    ).rejects.toThrow('disk full');
    expect(order()).toEqual(['C:/work/gamma', 'C:/work/alpha', 'C:/work/beta']);
    expect(desktop.projectOrderSaving).toBe(false);
    await desktop.moveProject('C:/work/gamma', 'C:/work/beta', true);
    expect(order()).toEqual(['C:/work/alpha', 'C:/work/beta', 'C:/work/gamma']);
  });
  it('commits cross-project switches only on success and restores each session draft', async () => {
    let sessionFile = 'a';
    let cwd = 'alpha';
    let cancelled = false;
    const connect = vi.fn();
    const action: Bridge['action'] = async <T>(
      _: string,
      command: Parameters<Bridge['action']>[1],
    ) => {
      if (command.type === 'switch_session' && !cancelled) {
        sessionFile = command.path;
        cwd = sessionFile === 'a' ? 'alpha' : 'beta';
      }
      return (
        command.type === 'state'
          ? { sessionFile, cwd }
          : command.type === 'history'
            ? { messages: [], before: 0, hasMore: false }
            : { cancelled }
      ) as T;
    };
    const desktop = new Desktop({
      ...bridge,
      action,
      connect,
      events: async () => ({ runtimeId: 'r', sequence: 0, events: [] }),
      sessions: async () => [],
      save: vi.fn().mockResolvedValue(undefined),
    });
    desktop.connection = 'ready';
    desktop.runtimeId = 'r';
    desktop.project = 'alpha';
    desktop.snapshot = { sessionFile: 'a' };
    desktop.draft = 'alpha draft';
    cancelled = true;
    await desktop.openSession('beta', 'b');
    expect(desktop.project).toBe('alpha');
    expect(desktop.draft).toBe('alpha draft');
    cancelled = false;
    await desktop.openSession('beta', 'b');
    expect(desktop.project).toBe('beta');
    expect(desktop.draft).toBe('');
    desktop.draft = 'beta draft';
    await desktop.openSession('alpha', 'a');
    expect(desktop.draft).toBe('alpha draft');
    await desktop.openSession('beta', 'b');
    expect(desktop.draft).toBe('beta draft');
    expect(connect).not.toHaveBeenCalled();
    expect(desktop.runtimeId).toBe('r');
  });
  it('waits for startup prewarming before opening a session without starting a second Pi', async () => {
    let finish!: (value: Awaited<ReturnType<Bridge['connect']>>) => void;
    const connect = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const desktop = new Desktop({
      ...bridge,
      connect,
      save: vi.fn().mockResolvedValue(undefined),
    });
    vi.spyOn(desktop, 'refreshMetadata').mockResolvedValue();
    vi.spyOn(desktop, 'refreshHistory').mockResolvedValue();
    vi.spyOn(desktop, 'refreshSessions').mockResolvedValue();
    const switchSession = vi
      .spyOn(desktop, 'switchSession')
      .mockResolvedValue();
    const warming = desktop.connect('alpha');
    const opening = desktop.openSession('beta', 'b.jsonl');
    expect(connect).toHaveBeenCalledOnce();
    expect(switchSession).not.toHaveBeenCalled();
    finish({
      runtimeId: 'r',
      project: 'alpha',
      snapshot: {},
      version: '1.4.0',
      verified: true,
    });
    await Promise.all([warming, opening]);
    expect(connect).toHaveBeenCalledOnce();
    expect(switchSession).toHaveBeenCalledWith('b.jsonl', 'beta');
  });
  it('does not restore a session after connection failure', async () => {
    const desktop = fixture(vi.fn());
    vi.spyOn(desktop, 'connect').mockImplementation(async () => {
      desktop.connection = 'failed';
    });
    const restore = vi.spyOn(desktop, 'switchSession');
    await desktop.openSession('other-project', 'history.jsonl');
    expect(restore).not.toHaveBeenCalled();
  });
  it('keeps draft on rejection and never retries automatically', async () => {
    const action = vi
      .fn()
      .mockRejectedValue({ code: 'TIMEOUT', message: 'unknown result' });
    const desktop = fixture(action);
    desktop.connection = 'ready';
    desktop.runtimeId = 'r';
    desktop.draft = 'keep me';
    await expect(desktop.send()).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(desktop.draft).toBe('keep me');
    expect(action).toHaveBeenCalledTimes(1);
  });
  it('does not clear the visible transcript on cancelled session switch', async () => {
    const action = vi.fn().mockResolvedValue({ cancelled: true });
    const desktop = fixture(action);
    desktop.project = 'project';
    desktop.snapshot = { sessionFile: 'original' };
    desktop.messages = [
      {
        id: 'a',
        role: 'user',
        text: 'hello',
        thinking: '',
        contentRef: null,
        status: 'done',
        name: null,
      },
    ];
    await desktop.switchSession('other');
    expect(desktop.snapshot.sessionFile).toBe('original');
    expect(desktop.messages[0].text).toBe('hello');
  });
  it('drains reset before committing restored history', async () => {
    const message = {
      id: 'restored',
      role: 'assistant',
      text: 'preserved',
      thinking: '',
      contentRef: null,
      status: 'done',
      name: null,
    };
    const action: Bridge['action'] = async <T>(
      _: string,
      command: Parameters<Bridge['action']>[1],
    ) => {
      const result =
        command.type === 'history'
          ? { messages: [message], before: 0, hasMore: false }
          : command.type === 'state'
            ? { sessionFile: 'new' }
            : { cancelled: false };
      return result as T;
    };
    const events = vi
      .fn()
      .mockResolvedValueOnce({
        runtimeId: 'r',
        sequence: 1,
        events: [{ type: 'reset' }],
      })
      .mockResolvedValue({ runtimeId: 'r', sequence: 1, events: [] });
    const desktop = new Desktop({
      ...bridge,
      action,
      events,
      sessions: async () => [],
    });
    desktop.project = 'project';
    desktop.runtimeId = 'r';
    desktop.connection = 'ready';
    await desktop.switchSession('new');
    expect(events).toHaveBeenCalledTimes(2);
    expect(desktop.messages[0].text).toBe('preserved');
  });
  it('submits a dialog response only once across cancellation races', async () => {
    const action = vi.fn().mockResolvedValue(null);
    const desktop = fixture(action);
    const request = {
      type: 'extension_ui_request',
      id: 'request-1',
      method: 'confirm',
    };
    desktop.extensions = [request];
    await Promise.all([
      desktop.respond(request, { cancelled: true }),
      desktop.respond(request, { confirmed: true }),
    ]);
    expect(action).toHaveBeenCalledOnce();
  });
  it('keeps context stats scoped to the current runtime and session', async () => {
    let release!: (value: unknown) => void;
    const action = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const desktop = fixture(action);
    desktop.connection = 'ready';
    desktop.runtimeId = 'r';
    desktop.snapshot = { sessionFile: 'a' };
    const pending = desktop.refreshStats();
    expect(desktop.refreshStats()).toBe(pending);
    expect(action).toHaveBeenCalledOnce();
    // 会话已切换后到达的统计属于上一个会话，不能覆盖当前展示。
    desktop.snapshot = { sessionFile: 'b' };
    release({
      totalMessages: 2,
      tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
      cost: 0,
      contextUsage: { tokens: 10, contextWindow: 100, percent: 10 },
    });
    await pending;
    expect(desktop.stats).toBeNull();
    expect(desktop.statsLoading).toBe(false);
    // 同一会话的响应正常落地。
    const current = desktop.refreshStats();
    release({
      totalMessages: 3,
      tokens: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, total: 3 },
      cost: 0.01,
      contextUsage: { tokens: 20, contextWindow: 100, percent: 20 },
    });
    await current;
    expect(desktop.stats?.totalMessages).toBe(3);
    expect(desktop.stats?.contextUsage?.percent).toBe(20);
  });
  it('ignores context stats failures and skips the query while disconnected', async () => {
    const action = vi.fn().mockRejectedValue(new Error('查询失败'));
    const desktop = fixture(action);
    desktop.connection = 'ready';
    desktop.runtimeId = 'r';
    desktop.snapshot = { sessionFile: 'a' };
    desktop.stats = {
      userMessages: 1,
      assistantMessages: 0,
      toolCalls: 0,
      toolResults: 0,
      totalMessages: 1,
      tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
      cost: 0,
    };
    await desktop.refreshStats();
    // 用量是辅助信息：失败不弹全局错误，也保留上一次的数字。
    expect(desktop.stats?.totalMessages).toBe(1);
    expect(desktop.error).toBe('');
    action.mockClear();
    desktop.connection = 'disconnected';
    await desktop.refreshStats();
    expect(action).not.toHaveBeenCalled();
  });
});
