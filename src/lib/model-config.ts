/** 共享模型配置契约；values 只允许列明的能力字段，未知高级字段留在宿主。 */
export const thinkingLevels = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;
/** 中文含义与协议等级并列展示，保存值仍使用原始标识。 */
export const thinkingLabels: Record<string, string> = {
  off: '关闭 · off',
  minimal: '最低 · minimal',
  low: '低 · low',
  medium: '中 · medium',
  high: '高 · high',
  xhigh: '超高 · xhigh',
  max: '最高 · max',
};
export type ThinkingLevel = (typeof thinkingLevels)[number];
export interface ModelValues {
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  input?: ('text' | 'image')[];
  reasoning?: boolean;
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
}
export interface ModelConfig {
  id: string;
  overrideOnly: boolean;
  values: ModelValues;
  defaultThinking: string | null;
}
export interface CredentialChange {
  action: 'keep' | 'replace' | 'environment' | 'none' | 'clear';
  value: string;
  confirmReplace: boolean;
}
export interface ProviderConfig {
  id: string;
  name: string | null;
  baseUrl: string | null;
  api: string | null;
  credentialSource: string;
  credential: CredentialChange;
  models: ModelConfig[];
  removed: boolean;
  clearCredential: boolean;
}
export interface ModelSettings {
  revision: string;
  directory: string;
  providers: ProviderConfig[];
  defaultProvider: string | null;
  defaultModel: string | null;
  defaultThinkingLevel: string | null;
}
export interface Discovery {
  models: { id: string; name: string }[];
  truncated: boolean;
}
export function newProvider(id = ''): ProviderConfig {
  return {
    id,
    name: null,
    baseUrl: null,
    api: null,
    credentialSource: '未保存认证',
    credential: { action: 'keep', value: '', confirmReplace: false },
    models: [],
    removed: false,
    clearCredential: false,
  };
}
/** 不把继承误写为关闭；null 仅用于显式禁用某个思考等级。 */
export function setThinkingMapping(
  model: ModelConfig,
  level: ThinkingLevel,
  mode: string,
): void {
  const map = { ...model.values.thinkingLevelMap };
  if (mode === 'inherit') delete map[level];
  else map[level] = mode === 'disabled' ? null : level;
  if (Object.keys(map).length) model.values.thinkingLevelMap = map;
  else delete model.values.thinkingLevelMap;
}
export function defaultLevels(model: ModelConfig): readonly string[] {
  // reasoning 表示当前是否启用，不能用它阻止用户重新选择强度。
  const map = model.values.thinkingLevelMap;
  return thinkingLevels.filter(
    (level) => level === 'off' || map?.[level] !== null,
  );
}
