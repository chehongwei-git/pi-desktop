/** IPC 业务 DTO；与 Rust types.rs 对齐。组件不能自行构造或发送原始 Pi RPC。 */
export interface SidebarItem {
  kind: 'project' | 'session';
  path: string;
  name?: string | null;
  state?: 'archived' | 'deleted' | null;
}
export interface Settings {
  schemaVersion: number;
  piPath: string;
  runtimePath: string;
  extraPath: string[];
  sessionDir: string;
  recentProjects: string[];
  projectOrder: string[];
  pinnedSessions: string[];
  sidebarItems?: SidebarItem[];
  theme: 'system' | 'light' | 'dark';
  zoom: number;
}
export interface SessionSummary {
  path: string;
  id: string;
  cwd: string;
  name: string;
  preview: string;
  timestamp: string;
  modified: number;
  lastPromptAt?: string;
  warning: string | null;
}
export interface ToolPresentation {
  callId: string;
  name: string;
  command?: string | null;
  path?: string | null;
  offset?: number | null;
  limit?: number | null;
  argsRef?: string | null;
  writeRef?: string | null;
  diffRef?: string | null;
  diffPreview?: string;
  diffLines?: number;
  tail?: string;
  outputLines?: number;
  truncation?: {
    truncated: boolean;
    truncatedBy?: string | null;
    outputLines?: number | null;
    totalLines?: number | null;
    maxBytes?: number | null;
    maxLines?: number | null;
    firstLineExceedsLimit?: boolean | null;
  } | null;
  fullOutputPath?: string | null;
}
export interface Message {
  id: string;
  role: string;
  text: string;
  thinking: string;
  contentRef: string | null;
  /** 只有正文超出宿主预览上限时才需要全文入口。 */
  truncated?: boolean;
  status: string;
  name: string | null;
  /** 本地提交占位，Pi 返回正式用户消息后替换。 */
  delivery?: { mode: 'steer' | 'followUp'; state: 'sending' | 'queued' };
  tool?: ToolPresentation | null;
}
export interface Model {
  id: string;
  provider: string;
  name: string;
}
export interface Snapshot {
  cwd?: string;
  sessionFile?: string;
  sessionId?: string;
  sessionName?: string;
  isStreaming?: boolean;
  isCompacting?: boolean;
  model?: Model;
  thinkingLevel?: string;
  autoCompactionEnabled?: boolean;
  steeringMode?: 'all' | 'one-at-a-time';
  followUpMode?: 'all' | 'one-at-a-time';
}
export interface Command {
  name: string;
  description?: string;
  source: string;
  argumentHint?: string;
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
        | 'reload'
        | 'new_session'
        | 'models'
        | 'refresh_models'
        | 'thinking_levels'
        | 'commands'
        | 'state';
    }
  | { type: 'new_project_session'; project: string }
  | { type: 'switch_session'; path: string }
  | { type: 'rename'; name: string }
  | { type: 'set_model'; provider: string; model: string }
  | { type: 'set_thinking'; level: string }
  | { type: 'set_auto_compaction' | 'set_auto_retry'; enabled: boolean }
  | {
      type: 'set_steering_mode' | 'set_follow_up_mode';
      mode: 'all' | 'one-at-a-time';
    }
  | { type: 'compact'; instructions?: string }
  | { type: 'export'; path?: string }
  | { type: 'fork'; entryId: string }
  | { type: 'navigate_tree'; entryId: string; summarize: boolean }
  | {
      type:
        | 'clone'
        | 'session_stats'
        | 'last_assistant'
        | 'fork_messages'
        | 'session_tree';
    }
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
  projectOrder: [],
  pinnedSessions: [],
  theme: 'system',
  zoom: 100,
};
