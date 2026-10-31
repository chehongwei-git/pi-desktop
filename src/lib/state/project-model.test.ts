import { describe, expect, it, vi } from 'vitest';
import { Desktop } from './desktop.svelte';
import { bridge } from '../client';
import type { Settings } from '../types';

/** Pi 历史会话恢复各自旧值，桌面必须在使用前重新应用项目统一值。 */
describe('project model preferences', () => {
  function fixture(saved?: Settings) {
    const models = [
      { provider: 'test', id: 'a', name: 'A' },
      { provider: 'test', id: 'b', name: 'B' },
    ];
    let project = 'alpha';
    let sessionFile = 'old';
    let model = models[0];
    let thinkingLevel = 'high';
    let persisted: Settings | undefined;
    const action = vi.fn().mockImplementation(async (_runtime, command) => {
      if (command.type === 'switch_session' || command.type === 'new_session') {
        sessionFile = command.path ?? 'new';
        project = sessionFile.startsWith('beta') ? 'beta' : 'alpha';
        model = models[0];
        thinkingLevel = 'off';
      }
      if (command.type === 'set_model') {
        model = models.find((m) => m.id === command.model)!;
        thinkingLevel = 'off';
      }
      if (command.type === 'set_thinking') thinkingLevel = command.level;
      if (command.type === 'state')
        return { cwd: project, sessionFile, model, thinkingLevel };
      if (command.type === 'thinking_levels')
        return { levels: ['off', 'low', 'high'] };
      if (command.type === 'models') return { models };
      if (command.type === 'commands') return { commands: [] };
      return { cancelled: false };
    });
    const save = vi.fn().mockImplementation(async (settings) => {
      persisted = structuredClone(settings);
    });
    const desktop = new Desktop({ ...bridge, action, save });
    if (saved) desktop.settings = saved;
    desktop.project = project;
    desktop.runtimeId = 'r';
    desktop.connection = 'ready';
    desktop.models = models;
    desktop.snapshot = { cwd: project, sessionFile, model, thinkingLevel };
    vi.spyOn(desktop as any, 'drain').mockResolvedValue(undefined);
    vi.spyOn(desktop, 'refreshHistory').mockResolvedValue();
    vi.spyOn(desktop, 'refreshSessions').mockResolvedValue();
    return { desktop, action, save, persisted: () => persisted };
  }
  it('shares both choices across historical and new sessions, isolates projects and survives reload', async () => {
    const { desktop, persisted } = fixture();
    await desktop.setModel('test/b');
    await desktop.setThinking('low');
    await desktop.switchSession('alpha-history');
    expect(desktop.snapshot.model?.id).toBe('b');
    expect(desktop.snapshot.thinkingLevel).toBe('low');
    await desktop.switchSession('beta-history');
    expect(desktop.snapshot.model?.id).toBe('a');
    expect(desktop.snapshot.thinkingLevel).toBe('off');
    await desktop.setThinking('high');
    await desktop.switchSession('alpha-history');
    expect(desktop.snapshot.model?.id).toBe('b');
    expect(desktop.snapshot.thinkingLevel).toBe('low');
    await desktop.newSession();
    expect(desktop.snapshot.model?.id).toBe('b');
    expect(desktop.snapshot.thinkingLevel).toBe('low');
    const restarted = fixture(persisted());
    await restarted.desktop.switchSession('alpha-history');
    expect(restarted.desktop.snapshot.model?.id).toBe('b');
    expect(restarted.desktop.snapshot.thinkingLevel).toBe('low');
  });
  it('applies persisted preferences on connection before the first send', async () => {
    const source = fixture();
    await source.desktop.setModel('test/b');
    await source.desktop.setThinking('low');
    const saved = source.persisted()!;
    const models = source.desktop.models;
    let model = models[0];
    let thinkingLevel = 'off';
    const desktop = new Desktop({
      ...bridge,
      connect: vi
        .fn()
        .mockResolvedValue({
          runtimeId: 'new',
          project: 'alpha',
          version: 'test',
          verified: true,
          snapshot: {
            cwd: 'alpha',
            sessionFile: 'restored',
            model,
            thinkingLevel,
          },
        }),
      save: vi.fn().mockResolvedValue(undefined),
      sessions: vi.fn().mockResolvedValue([]),
      action: vi.fn().mockImplementation(async (_runtime, command) => {
        if (command.type === 'models') return { models };
        if (command.type === 'thinking_levels')
          return { levels: ['off', 'low', 'high'] };
        if (command.type === 'set_model') {
          model = models[1];
          thinkingLevel = 'off';
        }
        if (command.type === 'set_thinking') thinkingLevel = command.level;
        if (command.type === 'state')
          return {
            cwd: 'alpha',
            sessionFile: 'restored',
            model,
            thinkingLevel,
          };
        if (command.type === 'history')
          return { messages: [], hasMore: false, before: 0 };
        return {};
      }),
    });
    desktop.settings = saved;
    await desktop.connect('alpha');
    expect(desktop.snapshot.model?.id).toBe('b');
    expect(desktop.snapshot.thinkingLevel).toBe('low');
  });
  it('uses the draft target project and normalizes Windows aliases', async () => {
    const { desktop } = fixture();
    desktop.prepareNewChat('C:\\Work\\App');
    await desktop.setThinking('low');
    desktop.prepareNewChat('c:/work/app');
    await desktop.setModel('test/b');
    expect(desktop.settings.projectModels).toHaveLength(1);
    expect(desktop.settings.projectModels?.[0]).toMatchObject({
      model: 'b',
      thinkingLevel: 'low',
    });
  });
  it('keeps the confirmed choice and draft when persistence fails', async () => {
    const { desktop, save } = fixture();
    desktop.draft = '草稿';
    save.mockRejectedValueOnce(new Error('disk failed'));
    await expect(desktop.setThinking('low')).rejects.toThrow(
      '项目设置保存失败',
    );
    expect(desktop.snapshot.thinkingLevel).toBe('low');
    expect(desktop.settings.projectModels?.[0].thinkingLevel).toBe('low');
    expect(desktop.draft).toBe('草稿');
  });
  it('does not send when the project model cannot be applied, and retries without recreating the session', async () => {
    const { desktop, action } = fixture();
    await desktop.setModel('test/b');
    const original = action.getMockImplementation()!;
    action.mockImplementation(async (...args) => {
      if (args[1].type === 'set_model') throw new Error('unavailable');
      return original(...args);
    });
    desktop.prepareNewChat('alpha');
    desktop.draft = 'hello';
    await expect(desktop.send()).rejects.toThrow('unavailable');
    expect(desktop.draft).toBe('hello');
    expect(
      action.mock.calls.some(([, command]) => command.type === 'prompt'),
    ).toBe(false);
    action.mockImplementation(original);
    await desktop.send();
    expect(
      action.mock.calls.filter(([, command]) => command.type === 'new_session'),
    ).toHaveLength(1);
    expect(desktop.snapshot.model?.id).toBe('b');
    expect(desktop.snapshot.thinkingLevel).toBe('high');
  });
});
