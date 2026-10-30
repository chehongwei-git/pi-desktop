/** Tauri 端口适配器；业务层可替换此对象，测试不需要桌面窗口或在线模型。 */
import { Channel, invoke } from '@tauri-apps/api/core';
import type {
  Action,
  ContentPage,
  EventBatch,
  SessionSummary,
  Settings,
  Snapshot,
  Wakeup,
} from './types';
export interface Connected {
  runtimeId: string;
  project: string;
  snapshot: Snapshot;
  version: string;
  verified: boolean;
}
export const bridge = {
  /** 启动前安装 Channel 回调，Pi 初始化时的扩展交互也不会丢失。 */
  connect(
    project: string,
    receive: (event: Wakeup) => void,
  ): Promise<Connected> {
    const channel = new Channel<Wakeup>();
    channel.onmessage = receive;
    return invoke('connect_pi', { project, channel });
  },
  /** 只允许白名单 Action；泛型仅描述对应业务响应。 */
  action<T = unknown>(runtimeId: string, action: Action): Promise<T> {
    return invoke('perform', { runtimeId, action });
  },
  /** 提交已归并的 sequence，以便宿主释放已确认 spool。 */
  events(runtimeId: string, ack: number): Promise<EventBatch> {
    return invoke('next_events', { runtimeId, ack });
  },
  /** 正文 ID 由宿主分配，不接受本地文件路径。 */
  content(runtimeId: string, id: string, offset: number): Promise<ContentPage> {
    return invoke('read_content', { runtimeId, id, offset });
  },
  /** 正常退出可等待自身进程树回收。 */
  disconnect(force = false): Promise<void> {
    return invoke('disconnect_pi', { force });
  },
  /** 配置中无密钥。 */
  settings(): Promise<Settings> {
    return invoke('get_settings');
  },
  /** 修改配置不会改变当前运行中的 Agent 环境。 */
  save(settings: Settings): Promise<void> {
    return invoke('save_settings', { settings });
  },
  /** 无项目也能检测安装，不创建会话。 */
  detect(settings: Settings): Promise<{
    version: string;
    verified: boolean;
    spec: { executable: string; args: string[] };
  }> {
    return invoke('detect_pi', { settings });
  },
  /** 历史只搜索元数据；project 为空时列出全部工作区，文件读取与摘要留在宿主。 */
  sessions(project: string, search = ''): Promise<SessionSummary[]> {
    return invoke('list_sessions', { project, search });
  },
};
export type Bridge = typeof bridge;
/** 将 Rust DTO、JS 异常和 Tauri 字符串错误归一为可读说明。 */
export function errorMessage(error: unknown): string {
  if (typeof error === 'object' && error && 'message' in error)
    return `${String(error.message)}${'diagnosticId' in error ? `（诊断 ${String(error.diagnosticId)}）` : ''}`;
  return String(error);
}
