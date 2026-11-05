import { describe, expect, it, vi } from 'vitest';
import { Desktop } from './desktop.svelte';
import { bridge } from '../client';

/** 覆盖空批次返回附近的微任务时序；宿主只唤醒一次也必须消费新消息。 */
describe('event wakeup at batch completion', () => {
  it.each([0, 1, 2, 3, 4, 5, 6])(
    'delivers a wakeup delayed by %i microtasks',
    async (delay) => {
      let desktop: Desktop;
      let announced = false;
      let queued = false;
      const events = vi.fn().mockImplementation(async () => {
        if (!announced) {
          announced = true;
          let wake = Promise.resolve();
          for (let index = 0; index < delay; index++)
            wake = wake.then(() => {});
          void wake.then(() => {
            queued = true;
            (desktop as any).receive({ type: 'available', runtimeId: 'r' }, 0);
          });
          return { runtimeId: 'r', sequence: 0, events: [] };
        }
        const messages = queued
          ? [
              {
                type: 'message',
                message: {
                  id: 'arrived',
                  role: 'assistant',
                  text: 'new reply',
                  thinking: '',
                  status: 'done',
                  contentRef: null,
                  name: null,
                },
              },
            ]
          : [];
        queued = false;
        return { runtimeId: 'r', sequence: 1, events: messages };
      });
      desktop = new Desktop({ ...bridge, events });
      desktop.runtimeId = 'r';
      desktop.connection = 'ready';
      await (desktop as any).drain();
      // 不依赖墙钟等待，排空宿主响应及其唤醒链。
      for (let index = 0; index < 30; index++) await Promise.resolve();
      expect(desktop.messages.map((message) => message.id)).toContain(
        'arrived',
      );
      expect(queued).toBe(false);
    },
  );
});
