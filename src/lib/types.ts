/** IPC 业务 DTO；与 Rust types.rs 对齐。组件不能自行构造或发送原始 Pi RPC。 */
export interface Settings {
  schemaVersion: number;
  piPath: string;
  runtimePath: string;
  extraPath: string[];
  sessionDir: string;
  recentProjects: string[];
  theme: 'system' | 'light' | 'dark';
}
export interface SessionSummary {
  path: string;
  id: string;
  cwd: string;
  name: string;
  preview: string;
  timestamp: string;
  modified: number;
  warning: string | null;
}
export interface Message {
  id: string;
  role: string;
  text: string;
  thinking: string;
  contentRef: string | null;
  status: string;
  name: string | null;
}
export interface Model {
  id: string;
  provider: string;
  name: string;
}
export interface Snapshot {
  sessionFile?: string;
  sessionId?: string;
  sessionName?: string;
  isStreaming?: boolean;
  model?: Model;
  thinkingLevel?: string;
}
export interface Command {
  name: string;
  description?: string;
  source: string;
}
export interface HistoryPage {
  messages: Message[];
  before: number;
  hasMore: boolean;
}
export interface ContentPage {
  text: string;
  next: number;
  done: boolean;
}
export type RunState =
  'idle' | 'running' | 'retrying' | 'compacting' | 'aborting';
export type ConnectionState =
  'disconnected' | 'starting' | 'ready' | 'stopping' | 'failed';
/** 扩展请求 id 属于 Pi，取消/超时后不能复用于下一请求。 */
export interface ExtensionRequest {
  type: string;
  id: string;
  method: string;
  title?: string;
  message?: string;
  options?: string[];
  defaultValue?: string;
  prefill?: string;
  text?: string;
  timeout?: number;
  statusKey?: string;
  statusText?: string;
  widgetKey?: string;
  widgetLines?: string[];
}
export type AppEvent =
  | { type: 'message'; message: Message }
  | { type: 'delta'; id: string; field: 'text' | 'thinking'; delta: string }
  | { type: 'run'; state: RunState }
  | { type: 'reset' }
  | { type: 'extension'; request: ExtensionRequest }
  | {
      type: 'metadata';
      data: {
        type: string;
        name?: string;
        level?: string;
        steering?: string[];
        followUp?: string[];
      };
    }
  | { type: 'notice'; message: string };
export interface EventBatch {
  runtimeId: string;
  sequence: number;
  events: AppEvent[];
}
export interface AppError {
  code: string;
  message: string;
  diagnosticId: string;
}
export type Wakeup =
  | { type: 'available'; runtimeId: string }
  | { type: 'failed'; runtimeId: string; error: AppError };
export type Action =
  | { type: 'prompt'; message: string; mode?: 'steer' | 'followUp' }
  | {
      type:
        | 'stop'
        | 'new_session'
        | 'models'
        | 'thinking_levels'
        | 'commands'
        | 'state';
    }
  | { type: 'switch_session'; path: string }
  | { type: 'rename'; name: string }
  | { type: 'set_model'; provider: string; model: string }
  | { type: 'set_thinking'; level: string }
  | { type: 'history'; before?: number }
  | {
      type: 'extension_response';
      id: string;
      value: { value?: string; confirmed?: boolean; cancelled?: boolean };
    };
export const defaultSettings: Settings = {
  schemaVersion: 1,
  piPath: '',
  runtimePath: '',
  extraPath: [],
  sessionDir: '',
  recentProjects: [],
  theme: 'system',
};
