/** 右下角用量指标：折叠读数、就地展开、键盘与焦点恢复都要可验证。 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ContextUsage from './ContextUsage.svelte';
import { Desktop } from '../state/desktop.svelte';
import { bridge } from '../client';
import type { ContextUsage as Usage, SessionStats } from '../types';

afterEach(cleanup);

function stats(usage: Usage | undefined): SessionStats {
  return {
    sessionFile: 'a',
    sessionId: 's',
    userMessages: 2,
    assistantMessages: 2,
    toolCalls: 3,
    toolResults: 3,
    totalMessages: 7,
    tokens: {
      input: 50000,
      output: 10000,
      cacheRead: 40000,
      cacheWrite: 5000,
      total: 105000,
    },
    cost: 0.45,
    contextUsage: usage,
  };
}

const defaultUsage: Usage = {
  tokens: 24600,
  contextWindow: 200000,
  percent: 12.3,
};

function fixture(usage: Usage | null = defaultUsage) {
  const payload = stats(usage ?? undefined);
  // 刷新统计会真实发一次查询；让端口返回同一份数据，界面不会因刷新而卸载。
  const action = vi.fn().mockResolvedValue(payload);
  const desktop = new Desktop({ ...bridge, action });
  desktop.connection = 'ready';
  desktop.runtimeId = 'r';
  desktop.snapshot = { sessionFile: 'a', autoCompactionEnabled: true };
  desktop.stats = payload;
  return { desktop, action };
}

describe('context usage meter', () => {
  it('summarizes the context window and exposes it to assistive tech', () => {
    const { desktop } = fixture();
    const view = render(ContextUsage, { desktop });
    const trigger = view.getByRole('button', { name: /上下文使用率/ });
    expect(trigger).toHaveTextContent('12.3% · 25k/200k');
    expect(trigger).toHaveTextContent('自动');
    expect(trigger).toHaveAttribute('data-tone', 'normal');
    expect(trigger).toHaveAccessibleName(
      '上下文使用率 12.3%，已用 25k，上限 200k，已开启自动压缩',
    );
  });

  it('marks warning and error thresholds in text, not only in color', () => {
    const { desktop } = fixture({
      tokens: 185000,
      contextWindow: 200000,
      percent: 92.5,
    });
    const view = render(ContextUsage, { desktop });
    const trigger = view.getByRole('button', { name: /上下文使用率/ });
    expect(trigger).toHaveAttribute('data-tone', 'error');
    expect(trigger).toHaveAccessibleName(/接近上限/);
  });

  it('expands the detail panel in place, refreshes stats and restores focus on Escape', async () => {
    const { desktop, action } = fixture();
    const view = render(ContextUsage, { desktop });
    const trigger = view.getByRole('button', { name: /上下文使用率/ });
    await fireEvent.click(trigger);
    const panel = view.getByRole('group', { name: '上下文用量明细' });
    expect(panel).toBeInTheDocument();
    expect(panel).toHaveTextContent('累计输入');
    expect(panel).toHaveTextContent('50k');
    expect(panel).toHaveTextContent('42.1%');
    expect(panel).toHaveTextContent('$0.450');
    // 展开时刷新一次，避免展示上一次任务结束时的数字。
    await waitFor(() =>
      expect(action).toHaveBeenCalledWith('r', { type: 'session_stats' }),
    );
    // 刷新期间操作按钮处于禁用状态，焦点先落在面板本身，Tab 再进入操作项。
    await waitFor(() => expect(panel).toHaveFocus());
    await fireEvent.keyDown(panel, { key: 'Escape' });
    expect(view.queryByRole('group', { name: '上下文用量明细' })).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('explains unknown usage right after compaction', async () => {
    const { desktop } = fixture({
      tokens: null,
      contextWindow: 200000,
      percent: null,
    });
    const view = render(ContextUsage, { desktop });
    const trigger = view.getByRole('button', { name: /上下文使用率/ });
    expect(trigger).toHaveTextContent('?% · ?/200k');
    await fireEvent.click(trigger);
    expect(view.getByRole('status')).toHaveTextContent(
      '压缩后需要等待下一次回答',
    );
  });

  it('closes when the pointer leaves the component', async () => {
    const { desktop } = fixture();
    const view = render(ContextUsage, { desktop });
    const trigger = view.getByRole('button', { name: /上下文使用率/ });
    await fireEvent.click(trigger);
    expect(
      view.getByRole('group', { name: '上下文用量明细' }),
    ).toBeInTheDocument();
    await fireEvent.pointerDown(document.body);
    expect(view.queryByRole('group', { name: '上下文用量明细' })).toBeNull();
  });

  it('hides background session usage on a local new-chat draft', () => {
    const { desktop } = fixture();
    desktop.newChatProject = 'other-project';
    const view = render(ContextUsage, { desktop });
    expect(view.queryByRole('button', { name: /上下文使用率/ })).toBeNull();
  });

  it('renders nothing without a usable context window', () => {
    const { desktop } = fixture(null);
    // contextUsage 缺失表示当前模型没有可用窗口，指标块整体隐藏，不留空位。
    const view = render(ContextUsage, { desktop });
    expect(view.queryByRole('button', { name: /上下文使用率/ })).toBeNull();
    cleanup();
    desktop.stats = null;
    const empty = render(ContextUsage, { desktop });
    expect(empty.queryByRole('button', { name: /上下文使用率/ })).toBeNull();
  });
});
