<!-- 历史分页验收：网络等待期间继续滚动，提交时再获取阅读锚点。 -->
<script lang="ts">
  import Transcript from '../../src/lib/components/Transcript.svelte';
  import type { Message } from '../../src/lib/types';
  const host = window as any;
  const short = new URLSearchParams(location.search).has('short');
  function batch(start: number, count: number): Message[] {
    return Array.from({ length: count }, (_, i) => ({
      id: `history-${start + i}`,
      role: 'assistant',
      text: `历史消息 ${start + i}\n\n${'保留阅读位置。'.repeat(short ? 1 : 30)}`,
      thinking: '',
      status: 'done',
      contentRef: null,
      name: null,
    }));
  }
  let messages = $state(batch(100, short ? 1 : 20));
  let more = $state(true);
  let loading = $state(false);
  host.calls = 0;
  host.fail = false;
  host.release = undefined;
  async function older(beforeInsert: () => void) {
    loading = true;
    host.calls++;
    try {
      await new Promise<void>((resolve) => {
        host.release = resolve;
        if (short) setTimeout(resolve, 10);
      });
      if (host.fail) throw new Error('模拟历史读取失败');
      beforeInsert();
      host.anchor = [
        ...document.querySelectorAll<HTMLElement>('.message-item'),
      ].find(
        (node) =>
          node.getBoundingClientRect().bottom >
          document.querySelector('.transcript')!.getBoundingClientRect().top,
      );
      host.anchorTop = host.anchor?.getBoundingClientRect().top;
      messages = [
        ...batch(100 - host.calls * (short ? 1 : 20), short ? 1 : 20),
        ...messages,
      ];
      more = host.calls < (short ? 4 : 3);
    } finally {
      loading = false;
    }
  }
</script>

<Transcript
  {messages}
  hasMore={more}
  {loading}
  onolder={older}
  onfull={() => {}}
  onload={async () => {}}
  onvisible={() => {}}
  onerror={(message) => {
    throw new Error(message);
  }}
  toolViews={{}}
  ontoggletool={() => {}}
  read={async () => ({ text: '', next: 0, done: true })}
/>
