<!-- 隔离展示夹具：复用真实消息组件与主题，检查展开不会吞掉任务或草稿。 -->
<script lang="ts">
  import MessageView from '../../src/lib/components/MessageView.svelte';
  import type { Message } from '../../src/lib/types';
  import { SessionContent } from '../../src/lib/state/session-content';
  let views = $state<Record<string, Record<string, boolean>>>({});
  const content = new SessionContent();
  const rawMessage: Message = {
    id: 'skill',
    role: 'user',
    text: '原始技能消息',
    thinking: '',
    status: 'done',
    name: null,
    contentRef: null,
    textParts: [
      {
        kind: 'skill',
        id: 'skill',
        text: '',
        chars: 100000,
        contentRef: 'raw',
        truncated: true,
        skill: {
          name: 'document-review-with-a-long-skill-name',
          location: 'C:\\skills\\文档处理\\SKILL.md',
          text: '',
          contentRef: 'instructions',
          truncated: true,
        },
      },
      {
        kind: 'text',
        id: 'request',
        text: '请将这份内容整理成 Word 文档，保留所有表格。',
        chars: 30,
        contentRef: null,
        truncated: false,
      },
    ],
  };
  // 使用与真实会话相同的所有权转换，避免裸引用被宽松 mock 掩盖。
  const initial = content.bind(rawMessage, 'initial');
  const message = content.bind(rawMessage, 'restored', initial);
  content.retain([message]);
</script>

<div class="fixture">
  <MessageView
    {message}
    onfull={() => {}}
    onload={async () => {}}
    onerror={() => {}}
    toolViews={views}
    ontoggletool={(id, key) => {
      views = { ...views, [id]: { ...views[id], [key]: !views[id]?.[key] } };
    }}
    read={async (handle) => {
      const id = content.resolve(handle, 'restored');
      if (id !== 'instructions') throw new Error('错误的技能正文引用');
      return {
        text:
          '# 文档处理说明\n\n保留标题层次与表格。\n\n' +
          '长说明，按需阅读并保留代码缩进。\n'.repeat(60),
        next: 10000,
        done: true,
      };
    }}
  />
  <textarea aria-label="底部草稿">草稿保持不变</textarea>
</div>

<style>
  .fixture {
    max-width: 720px;
    margin: 40px auto;
    padding: 16px;
  }
  textarea {
    margin-top: 24px;
    width: 100%;
  }
</style>
