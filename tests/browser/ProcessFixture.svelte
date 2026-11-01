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
  let messages: Message[] = [
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
      id: 'answer',
      role: 'assistant',
      text: '检查完成，没有发现问题。',
      thinking: '先确认文件内容，再判断结果。',
      presentation: 'answer',
      process,
    },
  ];
  let toolViews = $state<Record<string, Record<string, boolean>>>({});
</script>

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
