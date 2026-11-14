<!-- 真实 Transcript 与 ReviewLayout 验证入口、窄屏返回及草稿保持。 -->
<script lang="ts">
  import Transcript from '../../src/lib/components/Transcript.svelte';
  import ReviewLayout from '../../src/lib/components/ReviewLayout.svelte';
  import type { Message } from '../../src/lib/types';
  const messages: Message[] = [
    {
      id: 'files',
      role: 'assistant',
      text: '已修改 `src/main.ts:2`，下载[报告](docs/报告.pdf)或[图片](assets/图.png)。另见[说明](docs/说明.md)、[失败](docs/missing.txt)、[项目外](../outside.txt)和[长路径](docs/很长的目录名称/另一个很长的目录名称/包含完整说明的长文件名称.md)。',
      thinking: '',
      status: 'done',
      name: null,
      contentRef: null,
    },
  ];
</script>

<div class="workspace">
  <ReviewLayout>
    <div class="conversation">
      <Transcript
        {messages}
        project="/fixture-project"
        onolder={async () => {}}
        onfull={() => {}}
        onload={async () => {}}
        onvisible={() => {}}
        onerror={() => {}}
        toolViews={{}}
        ontoggletool={() => {}}
        read={async () => ({ text: '', next: 0, done: true })}
      />
      <textarea aria-label="底部草稿">保留草稿</textarea>
    </div>
  </ReviewLayout>
</div>

<style>
  .workspace {
    height: 100vh;
    display: flex;
    flex-direction: column;
  }
  textarea {
    margin: 12px;
  }
</style>
