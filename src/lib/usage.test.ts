/** 用量格式与阈值是 footer 可读性的基础，按终端规则锁定边界值。 */
import { describe, expect, it } from 'vitest';
import {
  cacheHitRate,
  contextLabel,
  formatCost,
  formatPercent,
  formatTokens,
  usageTone,
} from './usage';

describe('usage formatting', () => {
  it('matches the terminal token scale at every boundary', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(1000)).toBe('1.0k');
    expect(formatTokens(9999)).toBe('10.0k');
    expect(formatTokens(10000)).toBe('10k');
    expect(formatTokens(200000)).toBe('200k');
    expect(formatTokens(999999)).toBe('1000k');
    expect(formatTokens(1_000_000)).toBe('1.0M');
    expect(formatTokens(1_500_000)).toBe('1.5M');
    expect(formatTokens(12_000_000)).toBe('12M');
  });

  it('falls back to a question mark instead of NaN for unknown usage', () => {
    expect(formatTokens(null)).toBe('?');
    expect(formatTokens(undefined)).toBe('?');
    expect(formatTokens(Number.NaN)).toBe('?');
    expect(formatTokens(-1)).toBe('?');
    expect(formatPercent(null)).toBe('?');
    expect(formatPercent(Number.POSITIVE_INFINITY)).toBe('?');
    expect(formatPercent(12.34)).toBe('12.3');
  });

  it('grades tone with the terminal thresholds without treating unknown as safe', () => {
    expect(usageTone(null)).toBe('normal');
    expect(usageTone(70)).toBe('normal');
    expect(usageTone(70.1)).toBe('warning');
    expect(usageTone(90)).toBe('warning');
    expect(usageTone(90.1)).toBe('error');
  });

  it('describes the context window with and without a known token count', () => {
    // 与终端一致：>=10k 只保留整千，避免尾部小数误导精度。
    expect(
      contextLabel({ tokens: 24600, contextWindow: 200000, percent: 12.3 }),
    ).toBe('12.3% · 25k/200k');
    expect(
      contextLabel({ tokens: 9800, contextWindow: 200000, percent: 4.9 }),
    ).toBe('4.9% · 9.8k/200k');
    // 压缩后 Pi 返回 tokens/percent 为 null，此时仍需展示窗口上限。
    expect(
      contextLabel({ tokens: null, contextWindow: 200000, percent: null }),
    ).toBe('?% · ?/200k');
    expect(contextLabel(undefined)).toBe('');
  });

  it('reports cache hit rate and cost from session totals', () => {
    expect(
      cacheHitRate({
        input: 50000,
        output: 10000,
        cacheRead: 40000,
        cacheWrite: 5000,
        total: 105000,
      }),
    ).toBe('42.1%');
    expect(
      cacheHitRate({
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      }),
    ).toBe('—');
    expect(formatCost(0.45)).toBe('$0.450');
    expect(formatCost(0)).toBe('$0.000');
    expect(formatCost(undefined)).toBe('$0.000');
  });
});
