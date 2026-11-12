/** 插件配置投影不包含凭据；会话运行状态由独立会话模型维护。 */
import { invoke } from '@tauri-apps/api/core';
export type PluginKind = 'mcp' | 'skills' | 'extensions' | 'packages';
export interface Plugin {
  id: string;
  kind: PluginKind;
  name: string;
  description: string;
  source: string;
  scope: 'global' | 'project';
  enabled: boolean;
  inherited: boolean;
  overridden: boolean;
  problem: string | null;
}
export interface PluginCatalog {
  revision: string;
  directory: string;
  items: Plugin[];
  warnings: string[];
}
export interface PluginChange {
  revision: string;
  kind: PluginKind;
  id: string;
  action: 'add' | 'enable' | 'disable' | 'inherit' | 'remove';
  config?: Record<string, unknown>;
}
/** 远程目录仅投影展示所需字段，不包含 registry 原始文档或认证。 */
export interface NpmPackage {
  name: string;
  description: string;
  version: string;
  publisher: string;
  piPackage: boolean;
  piManifest: boolean;
}
export interface NpmSearch {
  exact: NpmPackage | null;
  items: NpmPackage[];
  warnings: string[];
}
/** 仅用于识别安装声明，普通名称不能直接转为可执行安装来源。 */
export function npmIdentity(source: string): string | null {
  if (!source.startsWith('npm:')) return null;
  const value = source.slice(4);
  const at = value.lastIndexOf('@');
  return at > 0 ? value.slice(0, at) : value;
}
/** 独立领域端口便于测试，不开放通用命令或文件访问。 */
export const pluginBridge = {
  search: (query: string): Promise<NpmSearch> =>
    invoke('npm_search', { query }),
  package: (name: string, version: string): Promise<NpmPackage> =>
    invoke('npm_detail', { name, version }),
  catalog: (project: string | null): Promise<PluginCatalog> =>
    invoke('plugin_catalog', { project }),
  change: (
    project: string | null,
    change: PluginChange,
  ): Promise<PluginCatalog> => invoke('change_plugin', { project, change }),
  detail: (project: string | null, item: Plugin): Promise<string> =>
    invoke('plugin_detail', { project, kind: item.kind, id: item.id }),
  command: (
    project: string | null,
    action: string,
    source = '',
  ): Promise<{ success: boolean; message: string }> =>
    invoke('plugin_command', { project, request: { action, source } }),
};
export const pluginTabs = [
  {
    id: 'mcp',
    label: 'MCP',
    icon: 'plug',
    title: 'MCP 服务器',
    description: '连接外部工具与数据源。',
  },
  {
    id: 'skills',
    label: 'Skills',
    icon: 'file',
    title: 'Skills',
    description: '为特定任务提供专业指引，按需读取。',
  },
  {
    id: 'extensions',
    label: '扩展',
    icon: 'plug',
    title: '扩展',
    description: '通过工具、命令与事件扩展 Pi。',
  },
] as const;
