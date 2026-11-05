import { describe, expect, it, vi } from 'vitest';
import { Desktop } from './desktop.svelte';
import { bridge } from '../client';

/** 模拟 Pi 在 set_model 后恢复默认等级，验证运行时实际强度而非仅检查显示值。 */
describe('model thinking preservation', () => {
  function fixture(levels = ['off', 'low', 'high']) {
    const models = [
      { provider: 'test', id: 'a', name: 'A' },
      { provider: 'test', id: 'b', name: 'B' },
    ];
    let model = models[0];
    let level = 'high';
    const action = vi.fn().mockImplementation(async (_runtime, command) => {
      if (command.type === 'set_model') {
        model = models[1];
        level = 'off';
      }
      if (command.type === 'set_thinking') level = command.level;
      if (command.type === 'state')
        return { model, thinkingLevel: level, sessionFile: 'session' };
      if (command.type === 'thinking_levels') return { levels };
      if (command.type === 'models') return { models };
      return {};
    });
    const desktop = new Desktop({ ...bridge, action });
    desktop.runtimeId = 'runtime';
    desktop.models = models;
    desktop.snapshot = { model, thinkingLevel: level, sessionFile: 'session' };
    desktop.draft = '保留草稿';
    return { desktop, action };
  }
  it('stages changes during a task and applies them only on the next explicit send', async () => {
    const { desktop, action } = fixture();
    desktop.connection = 'ready';
    desktop.run = 'running';
    await desktop.setModel('test/b');
    await desktop.setThinking('low');
    expect(desktop.selectedModel?.id).toBe('b');
    expect(desktop.selectedThinking).toBe('low');
    expect(desktop.snapshot.model?.id).toBe('a');
    expect(desktop.snapshot.thinkingLevel).toBe('high');
    expect(action).not.toHaveBeenCalled();
    desktop.run = 'idle';
    await Promise.resolve();
    expect(action).not.toHaveBeenCalled();
    expect(desktop.hasPendingModel).toBe(true);
    await desktop.send();
    expect(action).toHaveBeenCalledWith('runtime', {
      type: 'set_model',
      provider: 'test',
      model: 'b',
      thinking: 'low',
    });
    const calls = action.mock.calls.map(([, command]) => command.type);
    expect(calls.indexOf('set_model')).toBeLessThan(calls.indexOf('prompt'));
    expect(desktop.snapshot.model?.id).toBe('b');
    expect(desktop.snapshot.thinkingLevel).toBe('low');
    expect(desktop.hasPendingModel).toBe(false);
  });
  it('retains a staged model and draft when applying before send fails', async () => {
    const { desktop, action } = fixture();
    desktop.connection = 'ready';
    desktop.run = 'running';
    await desktop.setModel('test/b');
    const original = action.getMockImplementation()!;
    action.mockImplementation(async (...args) => {
      if (args[1].type === 'set_model') throw new Error('模型切换失败');
      return original(...args);
    });
    await expect(desktop.send()).rejects.toThrow('模型切换失败');
    expect(desktop.hasPendingModel).toBe(true);
    expect(desktop.selectedModel?.id).toBe('b');
    expect(desktop.draft).toBe('保留草稿');
    expect(
      action.mock.calls.some(([, command]) => command.type === 'prompt'),
    ).toBe(false);
    expect(desktop.submitting).toBe(false);
  });
  it('reapplies the current thinking level after switching models', async () => {
    const { desktop, action } = fixture();
    await desktop.setModel('test/b');
    expect(desktop.snapshot.model?.id).toBe('b');
    expect(desktop.snapshot.thinkingLevel).toBe('high');
    expect(action).toHaveBeenCalledWith('runtime', {
      type: 'set_thinking',
      level: 'high',
    });
    expect(desktop.draft).toBe('保留草稿');
  });
  it('reports unsupported levels and uses the confirmed runtime value', async () => {
    const { desktop, action } = fixture(['off']);
    await desktop.setModel('test/b');
    expect(desktop.snapshot.thinkingLevel).toBe('off');
    expect(desktop.notice).toContain('无法使用思考强度 high');
    expect(
      action.mock.calls.some(([, command]) => command.type === 'set_thinking'),
    ).toBe(false);
  });
  it('reports partial failure without hiding the successfully changed model', async () => {
    const { desktop, action } = fixture();
    const original = action.getMockImplementation()!;
    action.mockImplementation(async (...args) => {
      if (args[1].type === 'set_thinking') throw new Error('请求失败');
      return original(...args);
    });
    await expect(desktop.setModel('test/b')).rejects.toThrow(
      '模型已切换，但保留思考强度失败',
    );
    expect(desktop.snapshot.model?.id).toBe('b');
    expect(desktop.snapshot.thinkingLevel).toBe('off');
    expect(desktop.draft).toBe('保留草稿');
  });
  it('does not apply the previous session level after the session changes', async () => {
    const { desktop, action } = fixture();
    vi.spyOn(desktop, 'syncState').mockImplementation(async () => {
      desktop.snapshot = { sessionFile: 'other', thinkingLevel: 'low' };
    });
    await desktop.setModel('test/b');
    expect(
      action.mock.calls.some(([, command]) => command.type === 'set_thinking'),
    ).toBe(false);
    expect(desktop.snapshot.thinkingLevel).toBe('low');
  });
});
