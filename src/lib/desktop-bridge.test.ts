/** 桥接单元验证只替换 Pi 扩展 API，不创建 Agent、不访问用户配置。 */
import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error 桥接是由 Pi 直接加载的无依赖 JavaScript 资源。
import desktopBridge from '../../src-tauri/bridge/desktop.mjs';

type Context = {
  isIdle: () => boolean;
  reload: () => Promise<void>;
  model?: {
    provider: string;
    id: string;
    baseUrl?: string;
    api?: string;
    compat?: { forceAdaptiveThinking?: boolean; supportsTemperature?: boolean };
    reasoning?: boolean;
    thinkingLevelMap?: Record<string, string | null>;
  };
  modelRegistry: {
    refresh: ReturnType<typeof vi.fn>;
    getError: () => string | undefined;
    find: ReturnType<typeof vi.fn>;
  };
};
function fixture() {
  const handlers = new Map<
    string,
    (args: string, ctx: Context) => Promise<void>
  >();
  const setModel = vi.fn().mockResolvedValue(true);
  let level = 'off';
  const setThinkingLevel = vi.fn((value: string) => {
    level = value;
  });
  const events = new Map<string, (event: unknown, ctx: Context) => void>();
  desktopBridge({
    registerCommand(
      name: string,
      command: { handler: (args: string, ctx: Context) => Promise<void> },
    ) {
      handlers.set(name, command.handler);
    },
    setModel,
    on: (event: string, handler: (event: unknown, ctx: Context) => void) =>
      events.set(event, handler),
    getThinkingLevel: () => level,
    setThinkingLevel,
  });
  const ctx: Context = {
    isIdle: () => true,
    reload: vi.fn().mockResolvedValue(undefined),
    model: { provider: 'test', id: 'same-id' },
    modelRegistry: {
      refresh: vi.fn().mockResolvedValue({ errors: new Map(), aborted: false }),
      getError: () => undefined,
      find: vi.fn().mockReturnValue({
        provider: 'test',
        id: 'same-id',
        baseUrl: 'new-url',
      }),
    },
  };
  return {
    handlers,
    setModel,
    ctx,
    events,
    setThinkingLevel,
    getLevel: () => level,
  };
}
describe('Pi desktop bridge', () => {
  it.each(['session_start', 'model_select', 'before_agent_start'])(
    'uses capability metadata on %s independently of model names',
    (event) => {
      const { ctx, events } = fixture();
      for (const adaptive of [true, false]) {
        ctx.model = {
          provider: 'proxy',
          api: 'anthropic-messages',
          id: 'arbitrary-model',
          compat: { forceAdaptiveThinking: adaptive },
        };
        events.get(event)!({}, ctx);
        expect(ctx.model.compat?.forceAdaptiveThinking).toBe(adaptive);
        expect(ctx.model.thinkingLevelMap?.xhigh).toBe('high');
      }
    },
  );
  it.each(['claude-sonnet-4-6', 'anthropic/claude-sonnet-4.6'])(
    'automatically inherits official capabilities for proxy model %s',
    (id) => {
      const { ctx, events } = fixture();
      ctx.model = { provider: 'proxy', api: 'anthropic-messages', id };
      ctx.modelRegistry.find.mockReturnValue({
        compat: { forceAdaptiveThinking: true },
        thinkingLevelMap: { xhigh: null, max: 'max' },
      });
      events.get('session_start')!({}, ctx);
      expect(ctx.modelRegistry.find).toHaveBeenCalledWith(
        'anthropic',
        'claude-sonnet-4-6',
      );
      expect(ctx.model.compat?.forceAdaptiveThinking).toBe(true);
      expect(ctx.model.thinkingLevelMap?.xhigh).toBeNull();
      // 用户覆盖必须优先于自动识别结果。
      ctx.model.compat = { forceAdaptiveThinking: false };
      ctx.model.thinkingLevelMap = { xhigh: 'high' };
      events.get('model_select')!({}, ctx);
      expect(ctx.model.compat.forceAdaptiveThinking).toBe(false);
      expect(ctx.model.thinkingLevelMap.xhigh).toBe('high');
    },
  );
  it('uses explicit adaptive capability for arbitrary model aliases', () => {
    const { ctx, events } = fixture();
    ctx.model = {
      provider: 'proxy',
      api: 'anthropic-messages',
      id: 'custom-model-alias',
      compat: { forceAdaptiveThinking: true },
      thinkingLevelMap: { xhigh: 'xhigh' },
    };
    events.get('session_start')!({}, ctx);
    expect(ctx.model.compat?.forceAdaptiveThinking).toBe(true);
    expect(ctx.model.thinkingLevelMap?.xhigh).toBe('xhigh');
  });
  it('preserves explicit compatibility and effort mappings when selecting strength', async () => {
    const { ctx, handlers } = fixture();
    ctx.model = {
      provider: 'proxy',
      api: 'anthropic-messages',
      id: 'claude-opus-5-5',
      compat: { supportsTemperature: false, forceAdaptiveThinking: true },
      thinkingLevelMap: { xhigh: 'xhigh', max: null },
    };
    await handlers.get('pi-desktop-thinking-v1')!('{"level":"xhigh"}', ctx);
    expect(ctx.model.compat).toEqual({
      supportsTemperature: false,
      forceAdaptiveThinking: true,
    });
    expect(ctx.model.thinkingLevelMap).toMatchObject({
      xhigh: 'xhigh',
      max: null,
    });
    ctx.model.compat!.forceAdaptiveThinking = false;
    await handlers.get('pi-desktop-thinking-v1')!('{"level":"off"}', ctx);
    expect(ctx.model.compat?.forceAdaptiveThinking).toBe(false);
    expect(ctx.model.reasoning).toBe(false);
  });
  it.each([
    ['anthropic-messages', 'claude-sonnet-4-5'],
    ['anthropic-messages', 'custom-model-alias'],
    ['anthropic-messages', 'claude-opus-5-50'],
    ['openai-responses', 'claude-sonnet-4-5'],
    ['openai-completions', 'custom-model-alias'],
    ['openai-completions', 'claude-opus-5-5'],
  ])('does not change unrelated transport/model %s %s', (api, id) => {
    const { ctx, events } = fixture();
    ctx.model = { provider: 'proxy', api, id };
    events.get('session_start')!({}, ctx);
    expect(ctx.model.compat).toBeUndefined();
  });
  it('omits disabled thinking for adaptive Anthropic requests without changing the remaining payload', () => {
    const { ctx, events } = fixture();
    ctx.model = {
      provider: 'proxy',
      api: 'anthropic-messages',
      id: 'custom-adaptive-model',
      compat: { forceAdaptiveThinking: true },
    };
    const payload = {
      model: ctx.model.id,
      thinking: { type: 'disabled' },
      messages: [],
    };
    expect(events.get('before_provider_request')!({ payload }, ctx)).toEqual({
      model: ctx.model.id,
      messages: [],
    });
    expect(payload.thinking.type).toBe('disabled');
    ctx.model.compat = { forceAdaptiveThinking: false };
    expect(
      events.get('before_provider_request')!({ payload }, ctx),
    ).toBeUndefined();
    ctx.model.compat = { forceAdaptiveThinking: true };
    expect(
      events.get('before_provider_request')!(
        { payload: { thinking: { type: 'adaptive' } } },
        ctx,
      ),
    ).toBeUndefined();
  });
  it('learns explicit format errors for unknown aliases and isolates endpoints', () => {
    const { ctx, events } = fixture();
    ctx.modelRegistry.find.mockReturnValue(undefined);
    ctx.model = {
      provider: 'proxy',
      api: 'anthropic-messages',
      id: 'unknown-alias',
      baseUrl: 'https://one.test',
    };
    events.get('session_start')!({}, ctx);
    const error = (errorMessage: string) => ({
      message: { role: 'assistant', stopReason: 'error', errorMessage },
    });
    expect(
      events.get('message_end')!(error('429 rate limited'), ctx),
    ).toBeUndefined();
    expect(ctx.model.compat).toBeUndefined();
    const result = events.get('message_end')!(
      error(
        'unknown-alias requires adaptive thinking; omit thinking or use thinking.type=adaptive and output_config.effort',
      ),
      ctx,
    );
    expect(result).toMatchObject({
      message: { errorMessage: expect.stringContaining('请重试') },
    });
    expect(ctx.model.compat?.forceAdaptiveThinking).toBe(true);
    ctx.model = {
      ...ctx.model,
      compat: undefined,
      thinkingLevelMap: undefined,
    };
    events.get('model_select')!({}, ctx);
    expect(ctx.model.compat?.forceAdaptiveThinking).toBe(true);
    events.get('message_end')!(
      error('adaptive thinking is not supported'),
      ctx,
    );
    expect(ctx.model.compat?.forceAdaptiveThinking).toBe(false);
    ctx.model = {
      ...ctx.model,
      baseUrl: 'https://two.test',
      compat: undefined,
    };
    events.get('model_select')!({}, ctx);
    expect(ctx.model.compat).toBeUndefined();
  });
  it('does not learn over explicit configuration', () => {
    const { ctx, events } = fixture();
    ctx.model = {
      provider: 'proxy',
      api: 'anthropic-messages',
      id: 'alias',
      compat: { forceAdaptiveThinking: false },
    };
    events.get('session_start')!({}, ctx);
    expect(
      events.get('message_end')!(
        {
          message: {
            role: 'assistant',
            stopReason: 'error',
            errorMessage: 'requires adaptive thinking',
          },
        },
        ctx,
      ),
    ).toBeUndefined();
    expect(ctx.model.compat?.forceAdaptiveThinking).toBe(false);
  });
  it('enables reasoning for a selected strength and disables it for off', async () => {
    const { handlers, ctx, getLevel, events } = fixture();
    const apply = handlers.get('pi-desktop-thinking-v1')!;
    for (const level of ['xhigh', 'max', 'high', 'off', 'medium']) {
      await apply(JSON.stringify({ level }), ctx);
      expect(getLevel()).toBe(level);
      expect(ctx.model?.reasoning).toBe(level !== 'off');
    }
    ctx.model!.reasoning = false;
    events.get('session_start')!({}, ctx);
    expect(ctx.model!.reasoning).toBe(true);
    ctx.model!.thinkingLevelMap = { high: null };
    await expect(apply('{"level":"high"}', ctx)).rejects.toThrow('不支持');
    expect(getLevel()).toBe('medium');
  });
  it('restores the previous capability and level after a failed application', async () => {
    const { handlers, ctx, setThinkingLevel, getLevel } = fixture();
    ctx.model!.reasoning = false;
    setThinkingLevel.mockImplementationOnce(() => {
      throw new Error('应用失败');
    });
    await expect(
      handlers.get('pi-desktop-thinking-v1')!('{"level":"high"}', ctx),
    ).rejects.toThrow('应用失败');
    expect(getLevel()).toBe('off');
    expect(ctx.model!.reasoning).toBe(false);
  });
  it('never uses the stale context after reload', async () => {
    const { handlers, ctx } = fixture();
    const reload = vi.fn(async () => {
      Object.defineProperty(ctx, 'modelRegistry', {
        get() {
          throw new Error('stale');
        },
      });
    });
    ctx.reload = reload;
    await handlers.get('pi-desktop-reload-v1')!('', ctx);
    expect(reload).toHaveBeenCalledOnce();
  });
  it('refreshes local config and reapplies the new object with the same model id', async () => {
    const { handlers, ctx, setModel } = fixture();
    await handlers.get('pi-desktop-models-v1')!('', ctx);
    expect(ctx.modelRegistry.refresh).toHaveBeenCalledWith({
      allowNetwork: false,
    });
    expect(setModel).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: 'new-url' }),
    );
  });
  it('does not silently replace a deleted model', async () => {
    const { handlers, ctx, setModel } = fixture();
    ctx.modelRegistry.find.mockReturnValue(undefined);
    await expect(
      handlers.get('pi-desktop-models-v1')!('', ctx),
    ).rejects.toThrow('当前模型已被删除');
    expect(setModel).not.toHaveBeenCalled();
  });
  it('navigates through the command context and surfaces cancellation', async () => {
    const { handlers, ctx } = fixture();
    const navigateTree = vi.fn().mockResolvedValue({ cancelled: false });
    const context = { ...ctx, navigateTree };
    await handlers.get('pi-desktop-navigate-v1')!(
      JSON.stringify({ entryId: 'node', summarize: false }),
      context,
    );
    expect(navigateTree).toHaveBeenCalledWith('node', { summarize: false });
    navigateTree.mockResolvedValue({ cancelled: true });
    await expect(
      handlers.get('pi-desktop-navigate-v1')!(
        JSON.stringify({ entryId: 'node' }),
        context,
      ),
    ).rejects.toThrow('取消');
  });
  it('rejects busy sessions and malformed config', async () => {
    const { handlers, ctx } = fixture();
    ctx.isIdle = () => false;
    await expect(
      handlers.get('pi-desktop-reload-v1')!('', ctx),
    ).rejects.toThrow('等待');
    ctx.isIdle = () => true;
    ctx.modelRegistry.getError = () => 'invalid JSON';
    await expect(
      handlers.get('pi-desktop-models-v1')!('', ctx),
    ).rejects.toThrow('invalid JSON');
  });
});
