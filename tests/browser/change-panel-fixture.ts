/** 可控的分页、失败与迟到响应，验证真实列表和右侧面板。 */
import { mount } from 'svelte';
import Transcript from '../../src/lib/components/Transcript.svelte';
import type { Message } from '../../src/lib/types';
import '../../src/styles.css';
const host = window as any;
const messages: Message[] = Array.from({ length: 30 }, (_, i) => ({
  id: String(i),
  role: 'assistant',
  name: null,
  status: 'done',
  thinking: '',
  contentRef: null,
  text: `正文 ${i}\n\n${'阅读位置验证。'.repeat(20)}`,
}));
for (const id of ['a', 'b'])
  messages.push({
    id,
    role: 'toolResult',
    name: 'edit',
    status: 'done',
    thinking: '',
    contentRef: null,
    text: '编辑成功',
    tool: {
      callId: id,
      name: 'edit',
      path: `${id}.ts`,
      diffRef: id,
      addedLines: 401,
      removedLines: 1,
    },
  });
host.fail = true;
host.slow = false;
mount(Transcript, {
  target: document.querySelector('main')!,
  props: {
    messages,
    onolder: async () => {},
    onfull: () => {},
    onload: async () => {},
    onvisible: () => {},
    onerror: () => {},
    toolViews: {},
    ontoggletool: () => {},
    read: async (id, offset) => {
      if (host.slow && id === 'a')
        await new Promise<void>((resolve) => {
          host.release = resolve;
        });
      if (id === 'a' && offset > 0 && host.fail)
        throw new Error('模拟分页失败');
      if (!offset)
        return { text: `-1 old-${id}\n+1 new-${id}\n`, next: 100, done: false };
      return {
        text: Array.from(
          { length: 400 },
          (_, i) => `+${i + 2} tail-${id}-${i}`,
        ).join('\n'),
        next: 200,
        done: true,
      };
    },
  },
});
