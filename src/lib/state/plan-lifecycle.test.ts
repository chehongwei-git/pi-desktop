import { describe, expect, it, vi } from 'vitest';
import { Desktop } from './desktop.svelte';
import type { ExtensionRequest } from '../types';

/** 测试扩展边界与提交回执的交错，不依赖模型或本机 Pi。 */
function fixture() {
  const desktop = new Desktop();
  desktop.connection = 'ready';
  desktop.snapshot = { sessionFile: 'current.jsonl' };
  const action = vi.spyOn(desktop, 'action').mockResolvedValue({});
  const widget = (lines: string[]) => {
    (
      desktop as unknown as { extension(request: ExtensionRequest): void }
    ).extension({
      type: 'extension_ui_request',
      id: 'widget',
      method: 'setWidget',
      widgetKey: 'plan-todos',
      widgetLines: lines,
    });
  };
  const send = async () => {
    desktop.draft = '下一轮';
    await desktop.send();
  };
  return { desktop, action, widget, send };
}

describe('completed plan lifecycle', () => {
  it('keeps completion until accepted send, suppresses duplicates, and shows a new identical plan', async () => {
    const { desktop, widget, send } = fixture();
    widget(['☑ 验证']);
    expect(desktop.visibleWidgets['plan-todos']).toEqual(['☑ 验证']);
    await send();
    expect(desktop.visibleWidgets['plan-todos']).toEqual([]);
    expect(desktop.widgets['plan-todos']).toEqual(['☑ 验证']);
    widget(['☑ 验证', 'ℹ 已完成']);
    expect(desktop.visibleWidgets['plan-todos']).toEqual([]);
    widget(['☐ 验证']);
    expect(desktop.visibleWidgets['plan-todos']).toEqual(['☐ 验证']);
    widget(['☑ 验证']);
    expect(desktop.visibleWidgets['plan-todos']).toEqual(['☑ 验证']);
  });

  it('preserves incomplete, limited and unknown steps and ignores local commands', async () => {
    const { desktop, widget, send } = fixture();
    for (const lines of [['☐ 验证'], ['☑ 检查', '⊘ 验证'], ['未知步骤']]) {
      widget(lines);
      await send();
      expect(desktop.visibleWidgets['plan-todos']).toEqual(lines);
    }
    widget(['☑ 验证']);
    desktop.draft = '/settings';
    await desktop.send();
    expect(desktop.visibleWidgets['plan-todos']).toEqual(['☑ 验证']);
  });

  it('preserves completion on failure and ignores a late response after switching sessions', async () => {
    const { desktop, action, widget, send } = fixture();
    widget(['☑ 验证']);
    action.mockRejectedValueOnce(new Error('failed'));
    await expect(send()).rejects.toThrow('failed');
    expect(desktop.visibleWidgets['plan-todos']).toEqual(['☑ 验证']);
    let release!: () => void;
    action.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const task = send();
    desktop.snapshot = { sessionFile: 'other.jsonl' };
    release();
    await task;
    expect(desktop.visibleWidgets['plan-todos']).toEqual(['☑ 验证']);
  });

  it('does not hide a plan that completes or restarts during submission', async () => {
    const { desktop, action, widget, send } = fixture();
    widget(['☑ 验证']);
    let release!: () => void;
    action.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const task = send();
    widget(['☐ 验证']);
    widget(['☑ 验证']);
    release();
    await task;
    expect(desktop.visibleWidgets['plan-todos']).toEqual(['☑ 验证']);
    const other = fixture();
    expect(other.desktop.visibleWidgets['plan-todos']).toBeUndefined();
  });
});
