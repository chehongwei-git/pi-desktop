/** 验证真实桥接的边界决策、取消和上下文编辑，不访问用户配置或模型服务。 */
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error Pi 直接加载无依赖的 JavaScript 桥接资源。
import desktopBridge from '../../src-tauri/bridge/desktop.mjs';

function fixture() {
  const events = new Map<string, (event: any, ctx: any) => any>();
  desktopBridge({
    on(name: string, handler: (event: any, ctx: any) => any) {
      const previous = events.get(name);
      events.set(name, (event, ctx) => {
        previous?.(event, ctx);
        return handler(event, ctx);
      });
    },
    registerCommand: vi.fn(),
    getThinkingLevel: () => 'off',
  });
  const controller = new AbortController();
  const ctx = {
    signal: controller.signal as AbortSignal | undefined,
    hasPendingMessages: () => false,
    ui: { setStatus: vi.fn() },
  };
  const emit = (name: string, event: any = {}) =>
    events.get(name)?.(event, ctx);
  const failure = (
    errorMessage = 'Error reading response: malformed server-sent event JSON.',
  ) => ({
    role: 'assistant',
    stopReason: 'error',
    errorMessage,
    content: [{ type: 'text', text: '已生成的部分正文' }],
  });
  const turn = (message = failure(), overrides = {}) => ({
    message,
    messageEntryId: 'failed-entry',
    entries: [],
    outcome: 'error',
    continue: false,
    context: { pendingMessages: [] },
    ...overrides,
  });
  const settle = (overrides = {}) =>
    emit('agent_before_settle', {
      outcome: 'error',
      continue: false,
      entries: [],
      context: { pendingMessages: [], canContinue: true },
      ...overrides,
    });
  return { ctx, controller, emit, failure, turn, settle };
}

afterEach(() => vi.useRealTimers());

describe('桌面 SSE JSON 自动恢复', () => {
  it('以 2/4/8 秒退避，错误硬退出后在 settle 继续，第四次失败保留原始错误', async () => {
    vi.useFakeTimers();
    const f = fixture();
    for (const [index, delay] of [2000, 4000, 8000].entries()) {
      f.emit('turn_start');
      const message = f.failure();
      const pending = f.emit('turn_end', f.turn(message));
      expect(f.ctx.ui.setStatus).toHaveBeenLastCalledWith(
        'pi-desktop-sse-retry-v1',
        JSON.stringify({ attempt: index + 1, maxAttempts: 3, delayMs: delay }),
      );
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(f.settle()).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      const result = await pending;
      expect(result).toEqual({
        entries: [
          { type: 'context_edit', targetId: 'failed-entry', replacement: null },
        ],
      });
      // turn_end 的 continue 无法越过错误硬退出；这里只修复投影，settle 再继续。
      expect(result.continue).toBeUndefined();
      expect(f.settle()).toEqual({ continue: true });
      expect(f.settle()).toBeUndefined();
      expect(message.content[0].text).toBe('已生成的部分正文');
    }
    const original = f.failure();
    const final = f.emit('message_end', { message: original });
    expect(final.message.errorMessage).toBe(
      `${original.errorMessage}\n已自动重试 3 次，响应读取仍失败。`,
    );
    expect(original.errorMessage).not.toContain('已自动重试');
    expect(await f.emit('turn_end', f.turn(final.message))).toBeUndefined();
    expect(f.settle()).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    'malformed server-sent event JSON',
    'Provider: Error reading response: MALFORMED SERVER-SENT EVENT JSON.',
  ])('识别包装和大小写：%s', async (error) => {
    vi.useFakeTimers();
    const f = fixture();
    const pending = f.emit('turn_end', f.turn(f.failure(error)));
    await vi.advanceTimersByTimeAsync(2000);
    await pending;
    expect(f.settle()).toEqual({ continue: true });
  });

  it.each([
    'Unexpected token in JSON',
    '401 unauthorized',
    '429 rate limit',
    'context window exceeded',
  ])('不扩展其他错误策略：%s', async (error) => {
    const f = fixture();
    expect(await f.emit('turn_end', f.turn(f.failure(error)))).toBeUndefined();
    expect(f.settle()).toBeUndefined();
    expect(f.ctx.ui.setStatus).not.toHaveBeenCalled();
  });

  it.each(['abort', 'session_shutdown', 'agent_settled'])(
    '%s 立即取消等待且不产生迟到继续',
    async (event) => {
      vi.useFakeTimers();
      const f = fixture();
      const pending = f.emit('turn_end', f.turn());
      await vi.advanceTimersByTimeAsync(100);
      if (event === 'abort') f.controller.abort();
      else f.emit(event);
      expect(await pending).toBeUndefined();
      await vi.advanceTimersByTimeAsync(10000);
      expect(f.settle()).toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
      expect(f.ctx.ui.setStatus).toHaveBeenLastCalledWith(
        'pi-desktop-sse-retry-v1',
        undefined,
      );
    },
  );

  it('已取消、无取消信号、已有继续或队列时不安排额外请求', async () => {
    const f = fixture();
    for (const overrides of [
      { continue: true },
      { context: { pendingMessages: [{}] } },
      { message: { ...f.failure(), stopReason: 'aborted' } },
    ])
      expect(
        await f.emit('turn_end', f.turn(undefined, overrides)),
      ).toBeUndefined();
    f.ctx.signal = undefined;
    expect(await f.emit('turn_end', f.turn())).toBeUndefined();
    f.ctx.signal = f.controller.signal;
    f.controller.abort();
    expect(await f.emit('turn_end', f.turn())).toBeUndefined();
    expect(f.ctx.ui.setStatus).not.toHaveBeenCalled();
  });

  it('新请求消耗旧恢复决定，不在原生恢复或队列之后重复继续', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const pending = f.emit('turn_end', f.turn());
    await vi.advanceTimersByTimeAsync(2000);
    await pending;
    f.emit('turn_start');
    expect(f.settle()).toBeUndefined();
  });

  it('保留已有边界草稿与工具记录，只省略失败助手；成功后新错误重新计算', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const entries = [
      { type: 'custom', customType: 'existing', data: { ok: true } },
    ];
    const toolResults = [
      { role: 'toolResult', toolCallId: 'done-tool', content: '完成' },
    ];
    const pending = f.emit(
      'turn_end',
      f.turn(undefined, { entries, toolResults }),
    );
    await vi.advanceTimersByTimeAsync(2000);
    expect((await pending).entries).toEqual([
      ...entries,
      {
        type: 'context_edit',
        targetId: 'failed-entry',
        replacement: null,
      },
    ]);
    expect(toolResults[0].content).toBe('完成');
    expect(f.settle()).toEqual({ continue: true });
    await f.emit(
      'turn_end',
      f.turn({ ...f.failure(), stopReason: 'stop' }, { outcome: 'completed' }),
    );
    f.emit('agent_settled');
    const again = f.emit('turn_end', f.turn());
    await vi.advanceTimersByTimeAsync(2000);
    await again;
    expect(f.settle()).toEqual({ continue: true });
  });

  it('多会话隔离；settle 的既有继续或不可运行投影不被覆盖', async () => {
    vi.useFakeTimers();
    const first = fixture();
    const second = fixture();
    const pending = first.emit('turn_end', first.turn());
    await vi.advanceTimersByTimeAsync(2000);
    await pending;
    expect(second.settle()).toBeUndefined();
    expect(first.settle({ continue: true })).toBeUndefined();
    expect(first.settle()).toBeUndefined();
    const next = second.emit('turn_end', second.turn());
    await vi.advanceTimersByTimeAsync(2000);
    await next;
    expect(
      second.settle({ context: { pendingMessages: [], canContinue: false } }),
    ).toBeUndefined();
  });
});
