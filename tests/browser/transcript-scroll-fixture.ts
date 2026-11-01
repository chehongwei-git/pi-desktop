/** 浏览器诊断夹具：挂载真实对话列表，会话切换销毁旧列表并重新测量。 */
import { mount, unmount } from 'svelte';
import Transcript from '../../src/lib/components/Transcript.svelte';
import type { Message } from '../../src/lib/types';
import '../../src/styles.css';

const host = window as any;
const target = document.querySelector('main')!;
let app: ReturnType<typeof mount>;
host.switchHistory = async (kind = 'mixed') => {
  if (app) await unmount(app);
  const messages: Message[] = Array.from({ length: 240 }, (_, i) => {
    const tool = kind !== 'text' && i % 3 !== 0;
    const text = tool
      ? Array.from(
          { length: kind === 'expanded' ? 300 : 5 },
          (_, j) =>
            `输出 ${i}-${j} ${'连续长路径/中文abcdef/'.repeat(kind === 'expanded' ? 10 : (i % 5) + 1)}`,
        ).join('\n')
      : `消息 ${i}\n\n` +
        Array.from(
          { length: 1 + (i % 15) },
          (_, j) => `段落 ${j} ${'中文历史内容。'.repeat(5)}`,
        ).join('\n\n');
    return {
      id: `${kind}-${i}`,
      role: tool ? 'toolResult' : 'assistant',
      presentation: tool ? 'process' : 'answer',
      process: { id: `${kind}-${Math.floor(i / 3)}`, state: 'done' },
      text,
      thinking: '',
      status: 'done',
      contentRef: null,
      name: tool ? 'bash' : null,
      ...(tool
        ? {
            tool: {
              callId: `${kind}-${i}`,
              name: 'bash',
              command: `echo ${i}`,
              tail: text,
              outputLines: kind === 'expanded' ? 300 : 5,
            },
          }
        : {}),
    };
  });
  app = mount(Transcript, {
    target,
    props: {
      messages,
      onolder: async () => {},
      onfull: () => {},
      onload: async () => {},
      onvisible: () => {},
      onerror: (message: string) => {
        throw new Error(message);
      },
      toolViews: {
        ...Object.fromEntries(
          messages.map((m) => [`process-${m.process!.id}`, { process: true }]),
        ),
        ...(kind === 'expanded'
          ? Object.fromEntries(messages.map((m) => [m.id, { output: true }]))
          : {}),
      },
      ontoggletool: () => {},
      read: async () => ({ text: '', next: 0, done: true }),
    },
  });
};
void host.switchHistory('text');
