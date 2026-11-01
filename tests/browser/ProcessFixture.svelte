<script lang="ts">
  import Transcript from '../../src/lib/components/Transcript.svelte';
  import type { Message } from '../../src/lib/types';
  const process = {
    id: 'reply-1',
    startedAt: 1000,
    endedAt: 24000,
    state: 'done' as const,
  };
  const base = { thinking: '', contentRef: null, status: 'done', name: null };
  let messages = $state<Message[]>([
    { ...base, id: 'user', role: 'user', text: '检查文件' },
    {
      ...base,
      id: 'progress',
      role: 'assistant',
      text: '我先检查文件',
      presentation: 'process',
      process,
    },
    {
      ...base,
      id: 'read',
      role: 'toolResult',
      text: '文件内容',
      process,
      tool: { callId: 'read', name: 'read', path: 'example.ts' },
    },
    {
      ...base,
      id: 'blank',
      role: 'assistant',
      text: ' \r\n\t',
      contentRef: 'blank-body',
      process,
    },
    {
      ...base,
      id: 'answer',
      role: 'assistant',
      text: '检查完成，没有发现问题。',
      thinking: '先确认文件内容，再判断结果。',
      presentation: 'answer',
      process,
    },
  ]);
  // 用显式操作模拟流式更新和历史前插，验证既有折叠节点不因重分组而重建。
  function append(): void {
    const index = messages.findIndex((message) => message.id === 'answer');
    messages.splice(
      index,
      0,
      {
        ...base,
        id: 'more-thinking',
        role: 'assistant',
        text: '\n',
        thinking: '继续核对结果。',
        contentRef: 'more-blank-body',
        process,
      },
      {
        ...base,
        id: 'read-next',
        role: 'toolResult',
        text: '后续文件内容',
        process,
        tool: { callId: 'read-next', name: 'read', path: 'next.ts' },
      },
    );
  }
  function prepend(): void {
    const index = messages.findIndex((message) => message.id === 'read');
    messages.splice(
      index,
      0,
      {
        ...base,
        id: 'read-older',
        role: 'toolResult',
        text: '更早文件内容',
        process,
        tool: { callId: 'read-older', name: 'read', path: 'older.ts' },
      },
      {
        ...base,
        id: 'older-blank',
        role: 'assistant',
        text: '\t\n',
        contentRef: 'older-blank-body',
        process,
      },
    );
  }
  let toolViews = $state<Record<string, Record<string, boolean>>>({});
</script>

<div>
  <button onclick={append}>追加过程内容</button>
  <button onclick={prepend}>补载同组历史</button>
</div>
<Transcript
  {messages}
  {toolViews}
  ontoggletool={(id, section) => {
    toolViews[id] = { ...toolViews[id], [section]: !toolViews[id]?.[section] };
  }}
  onolder={async () => {}}
  onfull={() => {}}
  onload={async () => {}}
  onvisible={() => {}}
  onerror={() => {}}
  read={async () => ({ text: '文件内容', next: 0, done: true })}
/>
