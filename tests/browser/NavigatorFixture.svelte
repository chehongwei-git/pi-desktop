<!-- 真实布局验收：目录分页不插入正文，选择旧记录才串行补载。 -->
<script lang="ts">
  import Transcript from '../../src/lib/components/Transcript.svelte';
  import type { Message } from '../../src/lib/types';
  const host = window as any;
  const batch = (start: number, count: number): Message[] =>
    Array.from({ length: count }, (_, index) => ({
      id: `nav-${start + index}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      text: `消息 ${start + index} ${'阅读正文。'.repeat(35)}`,
      thinking: '',
      contentRef: null,
      name: null,
      status: 'done',
    }));
  let messages = $state(batch(20, 20));
  let more = $state(true);
  let active = $state(true);
  host.directoryCalls = 0;
  host.bodyCalls = 0;
  host.failDirectory = false;
  host.append = () => {
    messages = [...messages, ...batch(40, 2)];
  };
  host.setActive = (value: boolean) => {
    active = value;
  };
</script>

<div class="fixture" hidden={!active}>
  <Transcript
    {messages}
    {active}
    hasMore={more}
    onhistory={async (before) => {
      host.directoryCalls++;
      if (host.failDirectory) throw new Error('目录读取失败');
      return before === undefined
        ? { messages, before: 20, hasMore: more }
        : { messages: batch(0, 20), before: 0, hasMore: false };
    }}
    onolder={async (commit) => {
      host.bodyCalls++;
      if (host.delayBody)
        await new Promise<void>((resolve) => {
          host.releaseBody = resolve;
        });
      else await new Promise((resolve) => setTimeout(resolve, 50));
      commit();
      messages = [...batch(0, 20), ...messages];
      more = false;
    }}
    onfull={() => {}}
    onload={async () => {}}
    onvisible={() => {}}
    onerror={() => {}}
    toolViews={{}}
    ontoggletool={() => {}}
    read={async () => ({ text: '', next: 0, done: true })}
  />
  <textarea aria-label="草稿">保留我的草稿</textarea>
</div>

<style>
  .fixture {
    display: flex;
    flex-direction: column;
    height: 100vh;
  }
  .fixture[hidden] {
    display: none;
  }
  textarea {
    height: 80px;
    flex-shrink: 0;
  }
</style>
