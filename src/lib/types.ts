/** IPC 业务 DTO；与 Rust types.rs 对齐。组件不能自行构造或发送原始 Pi RPC。 */
export interface SidebarItem {
  kind: 'project' | 'session';
  path: string;
  name?: string | null;
  state?: 'archived' | 'deleted' | null;
}
/** 项目的新会话默认模型与强度；已有会话独立选择，目录按规范路径比较。 */
export interface ProjectModelPreference {
  project: string;
  provider: string;
  model: string;
  thinkingLevel: string;
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
  projectModels?: ProjectModelPreference[];
  theme: 'system' | 'light' | 'dark';
  zoom: number;
  /** 所有项目共享的执行上限。 */
  maxConcurrentTasks?: number;
  idleProcessLimit?: number;
}
/** 宿主调度摘要不包含提示词和图片。 */
export interface TaskActivity {
  taskId: string;
  runtimeId: string;
  state:
    'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'stopped';
  position: number;
  error?: string | null;
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
/** 侧栏同时呈现磁盘历史与尚未落盘的草稿；id 稳定，path 仅用于真实文件操作。 */
export interface SidebarSessionEntry extends Omit<
  SessionSummary,
  'id' | 'path'
> {
  id: string;
  path?: string;
  desktopId?: string;
  status: string;
  unread: boolean;
  archived: boolean;
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
  /** 宿主从完整差异统计，旧记录缺少统计时不估算。 */
  addedLines?: number | null;
  removedLines?: number | null;
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
/** 图片正文留在宿主；草稿才持有待发送的 Base64。 */
export interface MessageImage {
  id: string;
  mimeType: string;
  contentRef?: string;
  data?: string;
  name?: string;
}
/** 每组共用计时信息；结束时间冻结，历史恢复不重新计时。 */
export interface ProcessInfo {
  id: string;
  startedAt?: number;
  endedAt?: number;
  /** 扩展等待回答的起点及累计等待毫秒数；旧记录按零处理。 */
  pausedAt?: number;
  pausedMs?: number;
  state: 'running' | 'done' | 'stopped' | 'error';
}
/** 文件引用只描述已发送的路径，不授权读取或打开本机文件。 */
export interface MessageFileReference {
  id: string;
  path: string;
  directory?: boolean;
}
/** 输入范围采用 UTF-16，宿主严格校验后生成各片段正文引用。 */
export interface TextRange {
  kind: 'text' | 'paste' | 'files';
  files?: MessageFileReference[];
  id: string;
  start: number;
  end: number;
}
export interface MessageTextPart {
  kind: 'text' | 'paste' | 'files';
  files?: MessageFileReference[];
  id: string;
  text: string;
  chars: number;
  contentRef: string | null;
  truncated: boolean;
}
export interface Message {
  id: string;
  role: string;
  text: string;
  thinking: string;
  textParts?: MessageTextPart[];
  /** 兼容旧版分类；展示按内容拆分，普通正文始终直接显示。 */
  presentation?: 'process' | 'answer';
  process?: ProcessInfo;
  images?: MessageImage[];
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
  input?: ('text' | 'image')[];
  thinkingLevelMap?: Record<string, string | null>;
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
/** 上下文窗口估算；压缩后 tokens/percent 为 null，直到下一次模型回答才可信。 */
export interface ContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}
/** get_session_stats 投影：累计用量覆盖整条会话，包含工具与摘要产生的用量。 */
export interface SessionStats {
  sessionFile?: string;
  sessionId?: string;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  totalMessages: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: number;
  /** 无可用模型或上下文窗口时为 undefined。 */
  contextUsage?: ContextUsage;
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
  | {
      type: 'initialized';
      runtimeId: string;
      snapshot: Snapshot;
      project: string;
    }
  | {
      type: 'acquiring';
      runtimeId: string;
      phase: 'started' | 'opened' | 'created';
    }
  | { type: 'released'; runtimeId: string }
  | { type: 'available'; runtimeId: string }
  | { type: 'failed'; runtimeId: string; error: AppError };
export type Action =
  | {
      type: 'prompt';
      message: string;
      textParts?: TextRange[];
      images?: { type: 'image'; data: string; mimeType: string }[];
      mode?: 'steer' | 'followUp';
    }
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
  | { type: 'set_model'; provider: string; model: string; thinking?: string }
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
/** 新会话入队时固定的启动快照，与 Rust NewTaskRequest 对齐。 */
export interface NewTaskRequest {
  project: string;
  submissionId: string;
  action: Action;
  model?: [string, string];
  thinking?: string;
}
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
  maxConcurrentTasks: 4,
  idleProcessLimit: 5,
};
