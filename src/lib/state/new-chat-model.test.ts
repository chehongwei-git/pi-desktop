import { describe, expect, it, vi } from 'vitest';
import { Desktop } from './desktop.svelte';
import { bridge } from '../client';

/** 模拟 Pi 创建会话时恢复默认模型，验证实际 prompt 使用用户选择而非页面假状态。 */
describe('new chat model selection', () => {
  it.each(['alpha', 'beta'])(
    'keeps DeepSeek for the first prompt in %s',
    async (project) => {
      const gpt = { provider: 'openai', id: 'gpt', name: 'GPT' };
      const deepseek = { provider: 'proxy', id: 'deepseek', name: 'DeepSeek' };
      let current = gpt;
      let fail = false;
      let creations = 0;
      const sent: string[] = [];
      const action = vi.fn().mockImplementation(async (_runtime, command) => {
        if (
          command.type === 'new_session' ||
          command.type === 'new_project_session'
        ) {
          creations++;
          current = gpt;
        }
        if (command.type === 'set_model') {
          if (fail) throw new Error('model unavailable');
          current = command.model === 'deepseek' ? deepseek : gpt;
        }
        if (command.type === 'state')
          return { cwd: project, sessionFile: 'new.jsonl', model: current };
        if (command.type === 'prompt') sent.push(current.id);
        return { cancelled: false };
      });
      const desktop = new Desktop({
        ...bridge,
        action,
        save: vi.fn().mockResolvedValue(undefined),
      });
      desktop.connection = 'ready';
      desktop.runtimeId = 'r';
      desktop.project = 'alpha';
      desktop.models = [gpt, deepseek];
      desktop.snapshot = { cwd: 'alpha', sessionFile: 'old.jsonl', model: gpt };
      vi.spyOn(desktop, 'refreshMetadata').mockResolvedValue();
      vi.spyOn(desktop, 'refreshHistory').mockResolvedValue();
      vi.spyOn(desktop, 'refreshSessions').mockResolvedValue();
      vi.spyOn(desktop as any, 'drain').mockResolvedValue(undefined);
      desktop.prepareNewChat(project);
      await desktop.setModel('proxy/deepseek');
      desktop.draft = 'hello';
      fail = true;
      await expect(desktop.send()).rejects.toThrow('model unavailable');
      expect(sent).toEqual([]);
      expect(desktop.draft).toBe('hello');
      fail = false;
      await desktop.send();
      expect(creations).toBe(1);
      expect(sent).toEqual(['deepseek']);
      expect(desktop.snapshot.model?.id).toBe('deepseek');
      expect(desktop.draft).toBe('');
    },
  );
});
