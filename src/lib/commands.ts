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
  ['compact', '压缩会话上下文', '[instructions]'],
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

export function parseBuiltin(
  text: string,
): { name: string; args: string } | undefined {
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match || !builtinCommands.some((command) => command.name === match[1]))
    return;
  return { name: match[1], args: (match[2] ?? '').trim() };
}
