/** 对照 Pi core/slash-commands.ts；TUI 内置命令不会由 RPC get_commands 返回。 */
import type { Command } from './types';

export const builtinCommands: Command[] = [
  ['settings', '打开设置'],
  ['model', '选择模型', '<provider/model>'],
  ['tree', '查看会话树与分支'],
  ['thinking', '设置思考级别', '<level>'],
  ['scoped-models', '配置终端模型轮换范围'],
  ['export', '导出会话 HTML', '[path.html]'],
  ['import', '导入并恢复 JSONL 会话', '<path.jsonl>'],
  ['share', '分享会话'],
  ['bug', '向 Pi 开发者报告问题', '[description]'],
  ['copy', '复制最后一条助手回复'],
  ['name', '查看或设置会话名称', '[name]'],
  ['session', '查看会话信息与统计'],
  ['changelog', '查看 Pi 更新日志'],
  ['hotkeys', '查看桌面快捷键'],
  ['fork', '从历史用户消息创建分支'],
  ['clone', '复制当前会话'],
  ['trust', '保存项目信任决定'],
  ['login', '配置提供商身份验证', '[provider]'],
  ['logout', '移除提供商身份验证'],
  ['new', '开始新会话'],
  ['compact', '压缩会话上下文', '[可选压缩要求]'],
  ['resume', '恢复历史会话', '[path.jsonl]'],
  ['reload', '重新加载扩展、技能和模板'],
  ['quit', '断开当前 Pi 进程'],
].map(([name, description, argumentHint]) => ({
  name,
  description,
  argumentHint,
  source: 'builtin',
}));

/** Pi 内置名称优先；扩展、模板与技能保持服务端返回的顺序。 */
export function mergeCommands(commands: Command[]): Command[] {
  const names = new Set(builtinCommands.map((command) => command.name));
  return [
    ...builtinCommands,
    ...commands.filter((command) => {
      if (names.has(command.name)) return false;
      names.add(command.name);
      return true;
    }),
  ];
}

/** 分类顺序固定；内置按用途分组，动态资源按来源分组。 */
export const commandCategories = [
  '会话',
  '模型与思考',
  '设置与资源',
  '导出',
  '帮助',
  '扩展',
  '模板',
  '技能',
  '其他',
] as const;
export type CommandCategory = (typeof commandCategories)[number];
const builtinCategories: Record<string, CommandCategory> = {
  new: '会话',
  resume: '会话',
  name: '会话',
  session: '会话',
  tree: '会话',
  fork: '会话',
  clone: '会话',
  compact: '会话',
  copy: '会话',
  model: '模型与思考',
  thinking: '模型与思考',
  'scoped-models': '模型与思考',
  settings: '设置与资源',
  reload: '设置与资源',
  trust: '设置与资源',
  login: '设置与资源',
  logout: '设置与资源',
  quit: '设置与资源',
  export: '导出',
  import: '导出',
  share: '导出',
  bug: '帮助',
  changelog: '帮助',
  hotkeys: '帮助',
};
export function commandCategory(
  command: Pick<Command, 'name' | 'source'>,
): CommandCategory {
  if (command.source === 'builtin')
    return builtinCategories[command.name] ?? '其他';
  return (
    ({ extension: '扩展', prompt: '模板', skill: '技能' } as const)[
      command.source as 'extension' | 'prompt' | 'skill'
    ] ?? '其他'
  );
}
/** 仅在命令元数据变化时调用；同分类内保持原顺序。 */
export function categorizedCommands(commands: Command[]): Command[] {
  return mergeCommands(commands)
    .filter(
      (command) =>
        !command.name.startsWith('pi-desktop-') &&
        !(
          command.source === 'builtin' &&
          (unsupportedBuiltins[command.name] || command.name === 'hotkeys')
        ),
    )
    .sort(
      (a, b) =>
        commandCategories.indexOf(commandCategory(a)) -
        commandCategories.indexOf(commandCategory(b)),
    );
}

/** 明确显示当前实现边界；分类不代表功能已实现。 */
export const unsupportedBuiltins: Readonly<Record<string, string>> = {
  'scoped-models': '尚未适配模型轮换范围配置',
  import: '尚未适配 JSONL 导入',
  share: '尚未适配分享流程',
  bug: '尚未适配问题报告上传',
  trust: '尚未适配项目信任写入',
  login: '尚未适配认证流程',
  logout: '尚未适配凭据移除',
  changelog: '尚未适配 Pi 更新日志读取',
};
export function commandSupport(
  command: Pick<Command, 'name' | 'source'>,
): string {
  if (command.source !== 'builtin') return '';
  if (unsupportedBuiltins[command.name]) return '未支持';
  if (command.name === 'settings') return '部分设置';
  if (command.name === 'export') return '仅 HTML';
  return '';
}

export function parseBuiltin(
  text: string,
): { name: string; args: string } | undefined {
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match || !builtinCommands.some((command) => command.name === match[1]))
    return;
  return { name: match[1], args: (match[2] ?? '').trim() };
}
