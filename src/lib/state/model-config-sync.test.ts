import { describe, expect, it, vi } from 'vitest';
import { Desktop } from './desktop.svelte';
import { bridge } from '../client';
import { newProvider, type ModelSettings } from '../model-config';

function config(input?: ('text' | 'image')[]): ModelSettings {
  const provider = newProvider('test');
  provider.models = [
    { id: 'a', overrideOnly: false, values: { input }, defaultThinking: null },
  ];
  return {
    revision: '1',
    directory: '',
    providers: [provider],
    defaultProvider: null,
    defaultModel: null,
    defaultThinkingLevel: null,
  };
}

/** 配置保存不能让未连接草稿继续沿用旧能力，也不能丢失刷新期间的再次保存。 */
describe('model configuration synchronization', () => {
  it('updates draft image capabilities while retaining explicit text-only selection', () => {
    const desktop = new Desktop(bridge);
    desktop.navigation = {} as NonNullable<Desktop['navigation']>;
    desktop.newChatProject = 'project';
    desktop.models = [
      { provider: 'test', id: 'a', name: 'A', input: ['text'] },
    ];
    desktop.initializeDraftModel(desktop.models[0], 'high');
    desktop.modelConfigSaved(config());
    expect(desktop.selectedModel?.input).toEqual(['text']);
    desktop.modelConfigSaved(config(['text', 'image']));
    expect(desktop.selectedModel?.input).toEqual(['text', 'image']);
    expect(desktop.selectedThinking).toBe('high');
    desktop.modelConfigSaved(config(['text']));
    expect(desktop.selectedModel?.input).toEqual(['text']);
  });
  it('applies the latest saved revision after an in-flight refresh', async () => {
    let release!: () => void;
    const action = vi.fn().mockImplementation(async (_runtime, command) => {
      if (
        command.type === 'refresh_models' &&
        action.mock.calls.filter(([, c]) => c.type === 'refresh_models')
          .length === 1
      )
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return {};
    });
    const desktop = new Desktop({ ...bridge, action });
    desktop.connection = 'ready';
    desktop.runtimeId = 'runtime';
    vi.spyOn(desktop, 'syncState').mockResolvedValue();
    vi.spyOn(desktop, 'refreshMetadata').mockResolvedValue();
    desktop.modelConfigSaved(config());
    const applying = desktop.applyModelConfig();
    desktop.modelConfigSaved(config(['text']));
    release();
    await applying;
    expect(
      action.mock.calls.filter(([, c]) => c.type === 'refresh_models'),
    ).toHaveLength(2);
    expect(desktop.modelConfigPending).toBe(false);
  });
});
