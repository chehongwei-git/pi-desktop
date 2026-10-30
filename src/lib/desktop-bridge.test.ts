/** 桥接单元验证只替换 Pi 扩展 API，不创建 Agent、不访问用户配置。 */
import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error 桥接是由 Pi 直接加载的无依赖 JavaScript 资源。
import desktopBridge from '../../src-tauri/bridge/desktop.mjs';

type Context = {
  isIdle: () => boolean;
  reload: () => Promise<void>;
  model?: { provider: string; id: string };
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
  desktopBridge({
    registerCommand(
      name: string,
      command: { handler: (args: string, ctx: Context) => Promise<void> },
    ) {
      handlers.set(name, command.handler);
    },
    setModel,
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
  return { handlers, setModel, ctx };
}
describe('Pi desktop bridge', () => {
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
