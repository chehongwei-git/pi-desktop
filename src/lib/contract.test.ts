/** 共用 IPC 样例：TypeScript 编译契约与 Rust 序列化测试使用同一文件，字段变更必须同步。 */
import { expect, it } from 'vitest';
import fixture from '../../tests/fixtures/event-batch.json';
import type { EventBatch } from './types';
it('accepts the Rust IPC contract fixture', () => {
  const batch: EventBatch = fixture as EventBatch;
  expect(batch.events[0]).toMatchObject({
    type: 'message',
    message: { contentRef: 'body-1', name: null },
  });
});
