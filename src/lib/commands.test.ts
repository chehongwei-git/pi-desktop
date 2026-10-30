import { describe, expect, it } from 'vitest';
import { builtinCommands, mergeCommands, parseBuiltin } from './commands';

describe('Pi slash commands', () => {
  it('includes all 24 Pi builtins and preserves discovered resources without duplicate names', () => {
    expect(builtinCommands.map((command) => command.name)).toEqual([
      'settings',
      'model',
      'tree',
      'thinking',
      'scoped-models',
      'export',
      'import',
      'share',
      'bug',
      'copy',
      'name',
      'session',
      'changelog',
      'hotkeys',
      'fork',
      'clone',
      'trust',
      'login',
      'logout',
      'new',
      'compact',
      'resume',
      'reload',
      'quit',
    ]);
    const commands = mergeCommands([
      { name: 'model', source: 'extension' },
      { name: 'review', source: 'prompt' },
      { name: 'skill:test', source: 'skill' },
      { name: 'review', source: 'extension' },
    ]);
    expect(commands).toHaveLength(26);
    expect(commands.find((command) => command.name === 'model')?.source).toBe(
      'builtin',
    );
    expect(commands.slice(-2).map((command) => command.name)).toEqual([
      'review',
      'skill:test',
    ]);
  });
  it('parses exact builtin tokens and preserves multiline arguments', () => {
    expect(parseBuiltin('/compact focus on code\nand tests')).toEqual({
      name: 'compact',
      args: 'focus on code\nand tests',
    });
    expect(parseBuiltin(' /name 名称 ')).toEqual({
      name: 'name',
      args: '名称',
    });
    expect(parseBuiltin('/new')).toEqual({ name: 'new', args: '' });
    expect(parseBuiltin('/new-feature')).toBeUndefined();
    expect(parseBuiltin('/skill:test hello')).toBeUndefined();
    expect(parseBuiltin('explain /new')).toBeUndefined();
  });
});
