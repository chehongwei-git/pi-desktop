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
});
