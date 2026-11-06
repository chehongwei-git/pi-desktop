<script lang="ts">
  import MessageView from '../../src/lib/components/MessageView.svelte';
  import type { Message } from '../../src/lib/types';
  const files = [
    {
      id: 'a',
      path: '/project/设计资料/非常长的产品需求文档用于验证文件名省略和扩展名保留.pdf',
      directory: false,
    },
    { id: 'b', path: '/project/assets/icon.svg', directory: false },
    { id: 'c', path: '/project/src', directory: true },
    { id: 'd', path: '/project/README.md', directory: false },
    { id: 'e', path: '/project/extra.txt', directory: false },
  ];
  const suffix =
    '\n\n文件引用：\n' +
    files.map((file) => JSON.stringify(file.path)).join('\n');
  const message: Message = {
    id: 'm',
    role: 'user',
    text: '检查这些文件' + suffix,
    thinking: '',
    status: 'done',
    name: null,
    contentRef: null,
    textParts: [
      {
        kind: 'text',
        id: 't',
        text: '检查这些文件',
        chars: 6,
        contentRef: null,
        truncated: false,
      },
      {
        kind: 'files',
        id: 'f',
        text: suffix,
        chars: suffix.length,
        contentRef: null,
        truncated: false,
        files,
      },
    ],
  };
  let views = $state<Record<string, Record<string, boolean>>>({});
  function toggle(id: string, key: string) {
    views = { ...views, [id]: { ...views[id], [key]: !views[id]?.[key] } };
  }
</script>

<div class="fixture">
  <MessageView
    {message}
    toolViews={views}
    ontoggletool={toggle}
    onfull={() => {}}
    onload={async () => {}}
    onerror={() => {}}
    read={async () => ({ text: '', next: 0, done: true })}
  />
</div>

<style>
  .fixture {
    max-width: 760px;
    padding: 24px;
    margin: auto;
  }
</style>
