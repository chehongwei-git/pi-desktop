/** 每个可见内置命令的入口契约；动态资源只能发往 Pi，不冒充本地执行。 */
import { describe, expect, it, vi } from 'vitest';
import { categorizedCommands } from './commands';
import { Desktop } from './state/desktop.svelte';
import { bridge } from './client';

describe('slash command routing', () => {
  it.each(categorizedCommands([]).map((command) => command.name))(
    '/%s has a local execution entry and never becomes a model prompt',
    async (name) => {
      const action = vi.fn().mockResolvedValue({});
      const desktop = new Desktop({ ...bridge, action });
      desktop.connection = 'ready';
      desktop.draft = `/${name}`;
      vi.spyOn(desktop, 'refreshCommandSession').mockResolvedValue();
      vi.spyOn(desktop, 'syncState').mockResolvedValue();
      await desktop.send();
      if (name === 'compact')
        expect(action).toHaveBeenCalledWith('', {
          type: 'compact',
          instructions: undefined,
        });
      else expect(desktop.builtinRequest).toEqual({ name, args: '' });
      expect(
        action.mock.calls.some(([, command]) => command.type === 'prompt'),
      ).toBe(false);
    },
  );
  it.each(['extension-command', 'template-command', 'skill:review'])(
    '/%s delegates to Pi without opening a builtin dialog',
    async (name) => {
      const action = vi.fn().mockResolvedValue({ disposition: 'handled' });
      const desktop = new Desktop({ ...bridge, action });
      desktop.connection = 'ready';
      desktop.draft = `/${name} args`;
      await desktop.send();
      expect(action).toHaveBeenCalledWith('', {
        type: 'prompt',
        message: `/${name} args`,
        mode: undefined,
      });
      expect(desktop.builtinRequest).toBeNull();
      expect(desktop.submitting).toBe(false);
    },
  );
});
