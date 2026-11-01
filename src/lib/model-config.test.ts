import { describe, expect, it, vi } from 'vitest';
import {
  defaultLevels,
  newProvider,
  setThinkingMapping,
  type ModelConfig,
} from './model-config';
import { Desktop } from './state/desktop.svelte';
import { bridge } from './client';

function model(): ModelConfig {
  return {
    id: 'm',
    overrideOnly: false,
    values: { reasoning: true },
    defaultThinking: null,
  };
}
describe('model configuration rules', () => {
  it('distinguishes inheritance, explicit disable and extended levels', () => {
    const m = model();
    expect(defaultLevels(m)).toContain('max');
    expect(defaultLevels(m)).toContain('xhigh');
    setThinkingMapping(m, 'max', 'custom');
    expect(defaultLevels(m)).toContain('max');
    setThinkingMapping(m, 'high', 'disabled');
    expect(defaultLevels(m)).not.toContain('high');
    setThinkingMapping(m, 'high', 'inherit');
    expect(m.values.thinkingLevelMap).not.toHaveProperty('high');
    expect(defaultLevels(m)).toContain('high');
    m.values.reasoning = false;
    expect(defaultLevels(m)).toContain('high');
    expect(defaultLevels(m)).toContain('off');
  });
  it('defers application while running and preserves pending changes on failure', async () => {
    const config = {
      revision: 'a',
      directory: '/mock',
      providers: [newProvider('test')],
      defaultProvider: null,
      defaultModel: null,
      defaultThinkingLevel: null,
    };
    const action = vi.fn().mockRejectedValue(new Error('refresh failed'));
    const desktop = new Desktop({
      ...bridge,
      action,
      saveModelConfig: vi.fn().mockResolvedValue(config),
    });
    desktop.connection = 'ready';
    desktop.runtimeId = 'r';
    desktop.run = 'running';
    await desktop.saveModelConfig(config);
    expect(action).not.toHaveBeenCalled();
    expect(desktop.modelConfigPending).toBe(true);
    desktop.run = 'idle';
    await desktop.applyModelConfig();
    expect(desktop.modelConfigStatus).toContain('应用失败');
    expect(desktop.modelConfigPending).toBe(true);
    action.mockResolvedValue({});
    vi.spyOn(desktop, 'syncState').mockResolvedValue();
    vi.spyOn(desktop, 'refreshMetadata').mockResolvedValue();
    await desktop.applyModelConfig();
    expect(desktop.modelConfigPending).toBe(false);
  });
  it('ignores a refresh result from an old runtime', async () => {
    let finish!: () => void;
    const action = vi
      .fn()
      .mockImplementation(
        () => new Promise<void>((resolve) => (finish = resolve)),
      );
    const desktop = new Desktop({ ...bridge, action });
    desktop.connection = 'ready';
    desktop.runtimeId = 'old';
    desktop.modelConfigPending = true;
    const sync = vi.spyOn(desktop, 'syncState').mockResolvedValue();
    const applying = desktop.applyModelConfig();
    desktop.runtimeId = 'new';
    finish();
    await applying;
    expect(sync).not.toHaveBeenCalled();
    expect(desktop.modelConfigPending).toBe(true);
  });
});
