/** 新建会话沿用输入区显示的模型与强度，验证「显示什么就发送什么」不再跳变。 */
import { describe, expect, it, vi } from 'vitest';
import { Desktop } from './desktop.svelte';
import { bridge } from '../client';
import type { Model, Settings } from '../types';

const gpt: Model = { provider: 'openai', id: 'gpt', name: 'GPT' };
const deepseek: Model = { provider: 'proxy', id: 'deepseek', name: 'DeepSeek' };

/**
 * 模拟 Pi 的真实行为：新建/切换空会话时按全局默认模型与强度启动，
 * set_model 会把强度重置为 off，正是「发送后模型跳变」的来源。
 */
function fixture(preferences: NonNullable<Settings['projectModels']> = []) {
  const models = [gpt, deepseek];
  let project = 'alpha';
  let sessionFile = 'alpha.jsonl';
  let model: Model = deepseek;
  let thinkingLevel = 'max';
  let created = 0;
  const prompts: string[] = [];
  const action = vi.fn().mockImplementation(async (_runtime, command) => {
    if (command.type === 'new_project_session') {
      project = command.project;
      sessionFile = `${project}-${++created}.jsonl`;
      model = gpt;
      thinkingLevel = 'high';
    }
    if (command.type === 'new_session') {
      sessionFile = `${project}-${++created}.jsonl`;
      model = gpt;
      thinkingLevel = 'high';
    }
    if (command.type === 'switch_session') {
      sessionFile = command.path;
      project = command.path.startsWith('beta') ? 'beta' : 'alpha';
    }
    if (command.type === 'set_model') {
      model = models.find((item) => item.id === command.model)!;
      thinkingLevel = 'off';
    }
    if (command.type === 'set_thinking') thinkingLevel = command.level;
    if (command.type === 'prompt') prompts.push(model.id);
    if (command.type === 'state')
      return { cwd: project, sessionFile, model, thinkingLevel };
    if (command.type === 'models') return { models };
    if (command.type === 'thinking_levels')
      return { levels: ['off', 'low', 'high', 'max'] };
    if (command.type === 'history')
      return { messages: [], before: 0, hasMore: false };
    return { cancelled: false };
  });
  const desktop = new Desktop({
    ...bridge,
    action,
    save: vi.fn().mockResolvedValue(undefined),
  });
  desktop.settings.projectModels = preferences;
  desktop.connection = 'ready';
  desktop.runtimeId = 'r';
  desktop.project = project;
  desktop.models = models;
  desktop.levels = ['off', 'low', 'high', 'max'];
  desktop.snapshot = { cwd: project, sessionFile, model, thinkingLevel };
  vi.spyOn(desktop as any, 'drain').mockResolvedValue(undefined);
  vi.spyOn(desktop, 'refreshHistory').mockResolvedValue();
  vi.spyOn(desktop, 'refreshSessions').mockResolvedValue();
  return { desktop, action, prompts };
}

describe('draft model carryover', () => {
  it('carries the displayed model into a project without a saved preference', async () => {
    const { desktop, prompts } = fixture([
      {
        project: 'alpha',
        provider: 'proxy',
        model: 'deepseek',
        thinkingLevel: 'max',
      },
    ]);
    desktop.prepareNewChat('beta');
    expect(desktop.selectedModel?.id).toBe('deepseek');
    expect(desktop.selectedThinking).toBe('max');
    desktop.draft = '你好';
    await desktop.send();
    expect(prompts).toEqual(['deepseek']);
    expect(desktop.snapshot.model?.id).toBe('deepseek');
    expect(desktop.snapshot.thinkingLevel).toBe('max');
    // 沿用不等于写入偏好：只有用户显式修改才保存项目统一值。
    expect(
      desktop.settings.projectModels?.some((item) => item.project === 'beta'),
    ).toBe(false);
  });

  it('keeps the displayed model when creating another session in the same project', async () => {
    const { desktop, prompts } = fixture();
    desktop.prepareNewChat('alpha');
    expect(desktop.selectedModel?.id).toBe('deepseek');
    expect(desktop.selectedThinking).toBe('max');
    desktop.draft = '继续';
    await desktop.send();
    expect(prompts).toEqual(['deepseek']);
    expect(desktop.snapshot.thinkingLevel).toBe('max');
    expect(desktop.settings.projectModels).toEqual([]);
  });

  it('prefers the target project preference over the carried model', async () => {
    const { desktop, prompts } = fixture([
      {
        project: 'alpha',
        provider: 'proxy',
        model: 'deepseek',
        thinkingLevel: 'max',
      },
      {
        project: 'beta',
        provider: 'openai',
        model: 'gpt',
        thinkingLevel: 'low',
      },
    ]);
    desktop.prepareNewChat('beta');
    expect(desktop.selectedModel?.id).toBe('gpt');
    expect(desktop.selectedThinking).toBe('low');
    desktop.draft = '你好';
    await desktop.send();
    expect(prompts).toEqual(['gpt']);
    expect(desktop.snapshot.model?.id).toBe('gpt');
    expect(desktop.snapshot.thinkingLevel).toBe('low');
  });

  it('lets an explicit draft choice win and persist to the target project', async () => {
    const { desktop, prompts } = fixture();
    desktop.prepareNewChat('beta');
    await desktop.setModel('openai/gpt');
    expect(desktop.selectedModel?.id).toBe('gpt');
    desktop.draft = '你好';
    await desktop.send();
    expect(prompts).toEqual(['gpt']);
    expect(
      desktop.settings.projectModels?.find((item) => item.project === 'beta'),
    ).toMatchObject({ provider: 'openai', model: 'gpt' });
  });

  it('carries the displayed model when creating a session without a draft page', async () => {
    const { desktop } = fixture();
    await desktop.newSession();
    expect(desktop.snapshot.model?.id).toBe('deepseek');
    expect(desktop.snapshot.thinkingLevel).toBe('max');
  });

  it('falls back to the Pi default when the catalog is not ready', async () => {
    const { desktop, action, prompts } = fixture();
    desktop.models = [];
    desktop.prepareNewChat('beta');
    desktop.draft = '你好';
    await desktop.send();
    expect(prompts).toEqual(['gpt']);
    expect(
      action.mock.calls.some(([, command]) => command.type === 'set_model'),
    ).toBe(false);
  });

  it('retains the carried selection when applying it fails and retries without recreating the session', async () => {
    const { desktop, action, prompts } = fixture();
    desktop.prepareNewChat('beta');
    desktop.draft = '你好';
    const original = action.getMockImplementation()!;
    action.mockImplementation(async (...args) => {
      if (args[1].type === 'set_model') throw new Error('unavailable');
      return original(...args);
    });
    await expect(desktop.send()).rejects.toThrow('unavailable');
    expect(prompts).toEqual([]);
    expect(desktop.draft).toBe('你好');
    expect(
      action.mock.calls.filter(
        ([, command]) => command.type === 'new_project_session',
      ),
    ).toHaveLength(1);
    action.mockImplementation(original);
    await desktop.send();
    expect(prompts).toEqual(['deepseek']);
    expect(
      action.mock.calls.filter(
        ([, command]) => command.type === 'new_project_session',
      ),
    ).toHaveLength(1);
  });
});
