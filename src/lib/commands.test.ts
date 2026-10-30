import { describe, expect, it } from 'vitest';
import {
  builtinCommands,
  mergeCommands,
  parseBuiltin,
  categorizedCommands,
  commandCategory,
} from './commands';

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
  it('groups every builtin and hides internal bridge commands', () => {
    expect(
      builtinCommands.every((command) => commandCategory(command) !== '其他'),
    ).toBe(true);
    const commands = categorizedCommands([
      { name: 'pi-desktop-reload-v1', source: 'extension' },
      { name: 'review', source: 'prompt' },
    ]);
    expect(commands[0].name).toBe('tree');
    expect(commands).toHaveLength(16);
    for (const name of [
      'login',
      'logout',
      'share',
      'import',
      'bug',
      'trust',
      'changelog',
      'scoped-models',
      'hotkeys',
    ])
      expect(commands.some((command) => command.name === name)).toBe(false);
    expect(
      commands.some((command) => command.name.startsWith('pi-desktop-')),
    ).toBe(false);
    expect(commandCategory(commands.at(-1)!)).toBe('模板');
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
