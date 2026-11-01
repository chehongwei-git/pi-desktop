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
