<!-- 真实列表与对话面板联合验证，避免仅测试回调。 -->
<script lang="ts">
  import ReviewLayout from '../../src/lib/components/ReviewLayout.svelte';
  import Transcript from '../../src/lib/components/Transcript.svelte';
  import TurnChanges from '../../src/lib/components/TurnChanges.svelte';
  import type { Message } from '../../src/lib/types';
  let open:
    ((message: Message, trigger: HTMLButtonElement) => void) | undefined;
  let turns = $state([
    {
      id: 'one',
      title: '调整输入布局',
      state: 'done',
      warnings: ['并发编辑可能包含在结果中'],
      files: [
        {
          path: 'src/App.svelte',
          kind: 'modified',
          added: 1,
          removed: 1,
          binary: false,
          contentRef: 'diff',
        },
      ],
    },
  ]);
  // 测试入口模拟宿主生成新快照，不改变生产组件接口。
  function nextRound() {
    turns = [
      { ...turns[0], id: `round-${turns.length}`, title: '新一轮调整' },
      ...turns,
    ];
  }
</script>

<div
  style="display:flex;flex-direction:column;height:100vh;max-width:1500px;margin:auto"
>
  <ReviewLayout>
    <div style="flex:1;min-height:0;display:flex">
      <Transcript
        messages={[
          {
            id: 'answer',
            role: 'assistant',
            text: '布局已调整，可以检查修改。',
            thinking: '',
            status: 'done',
            contentRef: null,
            name: null,
          },
        ]}
        registerChange={(handler) => (open = handler)}
        toolViews={{}}
        ontoggletool={() => {}}
        onolder={async () => {}}
        onfull={() => {}}
        onload={async () => {}}
        onvisible={() => {}}
        onerror={() => {}}
        read={async () => ({
          text: '-1 const value = 1;\n+1 const value = 2;',
          next: 0,
          done: true,
        })}
      />
    </div>
    <div style="padding:16px;max-width:820px;width:100%;margin:auto">
      <TurnChanges
        {turns}
        onretry={() => {}}
        onselect={(message, trigger) => open?.(message, trigger)}
      />
      <button onclick={nextRound}>生成新轮次</button>
      <textarea aria-label="消息输入" style="width:100%;height:100px"
        >继续调整</textarea
      >
    </div>
  </ReviewLayout>
</div>
