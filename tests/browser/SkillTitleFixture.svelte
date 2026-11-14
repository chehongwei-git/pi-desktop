<!-- 使用真实侧栏会话组件，标题来自与本地草稿相同的摘要函数。 -->
<script lang="ts">
  import SidebarSession from '../../src/lib/components/SidebarSession.svelte';
  import { sessionPreview } from '../../src/lib/session-preview';
  const skill =
    '<skill name="ego-browser" location="/Users/example/.agents/skills/ego-browser/SKILL.md">\n浏览器说明\n</skill>';
  const titles = [
    sessionPreview(`${skill}\n\n请检查登录页面并修复窄窗口下按钮错位的问题`),
    sessionPreview(skill),
    '手动命名的会话',
  ];
</script>

<aside class="sidebar" aria-label="测试侧栏">
  <div class="section-label">最近会话</div>
  {#each titles as name, index}
    <SidebarSession
      session={{
        id: String(index),
        path: `${index}.jsonl`,
        cwd: '/project',
        name,
        preview: name,
        timestamp: '',
        modified: 0,
        warning: null,
      }}
      onopen={() => {}}
      onpin={() => {}}
    />
  {/each}
</aside>

<style>
  .sidebar {
    position: static;
    width: 288px;
    max-width: 100%;
    height: 100vh;
    padding-top: 24px;
  }
</style>
