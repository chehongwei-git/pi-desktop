<!-- 原地编辑的真实布局与草稿隔离验收，IPC 以确定性门面替换。 -->
<script lang="ts">
  import Transcript from '../../src/lib/components/Transcript.svelte';
  import { Desktop } from '../../src/lib/state/desktop.svelte';
  import { bridge } from '../../src/lib/client';
  import type { Message } from '../../src/lib/types';
  const host = window as any;
  const user: Message = {
    id: 'u',
    role: 'user',
    text: '请设计一个简洁、美观的消息编辑交互。',
    thinking: '',
    status: 'done',
    name: null,
    contentRef: null,
  };
  const reply = {
    ...user,
    id: 'a',
    role: 'assistant',
    text: '可以在消息旁提供铅笔图标，点击后原地编辑。',
  };
  let path = 'original.jsonl';
  let messages = [user, reply];
  host.sent = [];
  const desktop = new Desktop({
    ...bridge,
    action: async <T,>(_runtime: string, action: any): Promise<T> => {
      if (action.type === 'session_tree')
        return {
          nodes: [{ id: 'u', parentId: null, label: 'user' }],
          leafId: 'u',
        } as T;
      if (action.type === 'fork') {
        path = 'branch.jsonl';
        return { cancelled: false } as T;
      }
      if (action.type === 'state') return { sessionFile: path } as T;
      if (action.type === 'prompt') {
        host.sent.push(action.message);
        messages = [
          { ...user, id: 'edited', text: action.message },
          { ...reply, text: '这是重新生成的回答。' },
        ];
        return {} as T;
      }
      if (action.type === 'history')
        return { messages, before: 0, hasMore: false } as T;
      if (action.type === 'changes') return [] as T;
      return {} as T;
    },
    events: async () => ({ runtimeId: 'r', sequence: 0, events: [] }),
    sessions: async () => [],
  });
  desktop.runtimeId = 'r';
  desktop.connection = 'ready';
  desktop.snapshot = { sessionFile: path };
  desktop.messages = messages;
  host.setRunning = (value: boolean) => {
    desktop.run = value ? 'running' : 'idle';
  };
</script>

<div class="fixture">
  <Transcript
    messages={desktop.messages}
    edit={desktop.messageEdit}
    editUnavailable={desktop.run === 'idle' ? '' : '请等待当前任务结束后发送。'}
    onedit={(message) => {
      void desktop.editMessage(message);
    }}
    oncancelEdit={() => {
      desktop.messageEdit = null;
    }}
    onresend={() => {
      void desktop.resendMessage();
    }}
    onolder={async () => {}}
    onfull={() => {}}
    onload={async () => {}}
    onvisible={() => {}}
    onerror={() => {}}
    toolViews={{}}
    ontoggletool={() => {}}
    read={async () => ({ text: '', next: 0, done: true })}
  />
  <textarea class="bottom-draft" aria-label="底部草稿"
    >不要覆盖我的草稿</textarea
  >
</div>

<style>
  .fixture {
    display: flex;
    flex-direction: column;
    height: 100vh;
    max-width: 900px;
    margin: auto;
  }
  .bottom-draft {
    flex-shrink: 0;
    margin: 16px 24px;
    min-height: 80px;
  }
</style>
