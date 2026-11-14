import { describe, expect, it, vi } from 'vitest';
import { Desktop } from './desktop.svelte';
import { bridge, type Bridge } from '../client';

/** 连接和兼容的单实例历史切换都不能覆盖用户的导航偏好。 */
describe('侧栏展开与会话导航解耦', () => {
  it.each([
    '/projects/target',
    'C:\\Projects\\Target',
    '\\\\server\\share\\target',
  ])('连接、重连和历史切换保留展开偏好：%s', async (project) => {
    const api = {
      ...bridge,
      connect: async () => ({
        runtimeId: 'runtime',
        project,
        snapshot: { cwd: project, sessionFile: 'history.jsonl' },
        version: '1.4.0',
        verified: true,
      }),
      events: async () => ({ runtimeId: 'runtime', sequence: 0, events: [] }),
      save: async () => {},
      sessions: async () => [],
      action: vi.fn(async (_runtime, action) => {
        switch (action.type) {
          case 'state':
            return { cwd: project, sessionFile: 'other.jsonl' };
          case 'switch_session':
            return { cancelled: false };
          case 'history':
            return { messages: [], before: 0, hasMore: false };
          case 'models':
            return { models: [] };
          case 'thinking_levels':
            return { levels: [] };
          case 'commands':
            return { commands: [] };
          case 'changes':
            return [];
          default:
            return {};
        }
      }) as Bridge['action'],
    } satisfies Bridge;
    const desktop = new Desktop(api);
    desktop.toggleProject('/projects/kept');
    const expanded = [...desktop.expandedProjects];
    await desktop.connect(project);
    expect(desktop.connection).toBe('ready');
    expect(desktop.project).toBe(project);
    expect(desktop.expandedProjects).toEqual(expanded);
    await desktop.connect(project);
    expect(desktop.expandedProjects).toEqual(expanded);
    expect(await desktop.switchSession('other.jsonl', project)).toBe(true);
    expect(desktop.expandedProjects).toEqual(expanded);
    // 显式项目操作仍然有效，不把修复变成禁止展开项目。
    desktop.toggleProject(project);
    expect(desktop.isExpanded(project)).toBe(true);
    desktop.toggleProject(project);
    expect(desktop.expandedProjects).toEqual(expanded);
  });
});
