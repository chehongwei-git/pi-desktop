/** 上下文用量展示格式：与 Pi 终端 footer 的数字规则保持一致，只做纯计算。 */
import type { ContextUsage, SessionStats } from './types';

/** 百分比分级只表达语义，颜色由组件样式变量决定，便于明暗主题复用。 */
export type UsageTone = 'normal' | 'warning' | 'error';

/** 只在有限非负数上格式化；缺失或异常值回退为 `?`，避免出现 NaN。 */
function finite(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

/**
 * 与终端 formatTokens 完全一致的紧凑写法：
 * 999 → 999，1200 → 1.2k，200000 → 200k，1500000 → 1.5M。
 * 终端用 k/M 后缀，桌面沿用同一约定，避免与终端读数对不上。
 */
export function formatTokens(count: number | null | undefined): string {
  const value = finite(count);
  if (value === null) return '?';
  if (value < 1e3) return String(Math.round(value));
  if (value < 1e4) return `${(value / 1e3).toFixed(1)}k`;
  if (value < 1e6) return `${Math.round(value / 1e3)}k`;
  if (value < 1e7) return `${(value / 1e6).toFixed(1)}M`;
  return `${Math.round(value / 1e6)}M`;
}

/** 压缩后 percent 为 null，终端显示 `?`；这里保持同一表达，避免误导为 0%。 */
export function formatPercent(percent: number | null | undefined): string {
  const value = finite(percent);
  return value === null ? '?' : value.toFixed(1);
}

/** 终端阈值：>90 视为危险、>70 视为警告，其余正常。 */
export function usageTone(percent: number | null | undefined): UsageTone {
  const value = finite(percent);
  if (value === null) return 'normal';
  if (value > 90) return 'error';
  if (value > 70) return 'warning';
  return 'normal';
}

/** 折叠态单行文案：`12.3% · 25k/200k`，未知用量时保留上限信息。 */
export function contextLabel(usage: ContextUsage | undefined): string {
  if (!usage) return '';
  return `${formatPercent(usage.percent)}% · ${formatTokens(usage.tokens)}/${formatTokens(usage.contextWindow)}`;
}

/**
 * 累计缓存命中率：Pi 会话统计只给累计 cacheRead/cacheWrite/input，
 * 没有“最近一次请求”的分项，因此只能按会话累计值表述，不冒充瞬时命中率。
 */
export function cacheHitRate(tokens: SessionStats['tokens']): string {
  const read = finite(tokens?.cacheRead) ?? 0;
  const prompt =
    (finite(tokens?.input) ?? 0) + read + (finite(tokens?.cacheWrite) ?? 0);
  return prompt > 0 ? `${((read / prompt) * 100).toFixed(1)}%` : '—';
}

/** 费用统一三位小数；0 与缺失都显示 0.000，避免空字段造成歧义。 */
export function formatCost(cost: number | null | undefined): string {
  return `$${(finite(cost) ?? 0).toFixed(3)}`;
}
