<!-- 统一详情的标题、元信息与阅读区；Markdown 沿用受控渲染，不执行扩展代码。 -->
<script lang="ts">
  import type { Plugin } from '../plugins';
  import { markdown } from '../markdown';
  import Icon from './Icon.svelte';
  let {
    item,
    text,
    loading,
  }: { item: Plugin; text: string; loading: boolean } = $props();
  const typeName = $derived(
    item.kind === 'mcp'
      ? 'MCP 服务器'
      : item.kind === 'skills'
        ? 'Skill'
        : item.kind === 'packages'
          ? 'Pi 安装包'
          : '扩展',
  );
</script>

<section aria-label="插件详情" class="plugin-detail">
  <div class="detail-heading">
    <span class="detail-icon"
      ><Icon
        name={item.kind === 'skills'
          ? 'file'
          : item.kind === 'packages'
            ? 'folder'
            : 'plug'}
        size={24}
      /></span
    >
    <div>
      <span class="type-label">{typeName}</span>
      <h2>{item.name}</h2>
    </div>
    <span class="badge">{item.enabled ? '已启用' : '已停用'}</span>
  </div>
  <p class="description">
    {item.description || '此资源未提供描述，可查看下方来源信息。'}
  </p>
  <dl>
    <dt>配置范围</dt>
    <dd>
      {item.scope === 'global' ? '全局' : '项目'}{item.overridden
        ? ' · 项目覆盖'
        : ''}
    </dd>
    <dt>来源</dt>
    <dd class="source">{item.source}</dd>
    <dt>生效状态</dt>
    <dd>以上为磁盘配置，实际加载以会话为准。</dd>
  </dl>
  {#if item.problem}<div class="notice problem" role="alert">
      <Icon name="warning" size={17} /><span>{item.problem}</span>
    </div>{/if}
  {#if item.kind === 'skills'}<div class="notice">
      <Icon name="info" size={17} /><span
        >显式调用：<code>/skill:{item.name}</code
        >。请先审阅说明及附带脚本，再决定是否使用。</span
      >
    </div>{/if}
  <div class="reading-area" aria-busy={loading}>
    <h3>{item.kind === 'skills' ? '使用说明' : '接入说明'}</h3>
    {#if loading}<div class="loading" role="status">
        <Icon name="refresh" size={16} />正在读取详情…
      </div>
    {:else if item.kind === 'skills'}<!-- svelte-ignore a11y_no_noninteractive_tabindex (长说明区独立滚动，需允许键盘聚焦后滚动阅读。) -->
      <div
        class="skill-content markdown"
        tabindex="0"
        role="region"
        aria-label="Skill 使用说明"
      >
        {@html markdown(text)}
      </div>
    {:else}<p>{text || '暂无更多说明。'}</p>{/if}
  </div>
</section>

<style>
  .plugin-detail {
    border: 1px solid var(--border);
    border-radius: var(--radius-panel);
    padding: 26px;
    min-width: 0;
    background: var(--bg);
  }
  .detail-heading {
    display: flex;
    align-items: center;
    gap: 14px;
  }
  .detail-heading > div {
    min-width: 0;
    flex: 1;
  }
  .detail-icon {
    display: grid;
    place-items: center;
    width: 48px;
    height: 48px;
    flex-shrink: 0;
    background: var(--accent-soft);
    color: var(--accent);
    border: 1px solid var(--border);
    border-radius: 13px;
  }
  h2 {
    margin: 3px 0 0;
    font-size: 22px;
    line-height: 1.4;
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .type-label {
    font-size: 11px;
    color: var(--muted);
  }
  .badge {
    font-size: 11px;
    flex-shrink: 0;
    padding: 4px 9px;
    border-radius: 6px;
    background: var(--surface);
    color: var(--muted);
  }
  p {
    color: var(--muted);
    font-size: 13px;
    line-height: 1.8;
  }
  .description {
    margin: 18px 0 24px;
  }
  dl {
    display: grid;
    grid-template-columns: 80px minmax(0, 1fr);
    gap: 16px;
    font-size: 13px;
    margin: 0;
    padding: 22px 0;
    border-block: 1px solid var(--border);
    line-height: 1.7;
  }
  dt {
    color: var(--muted);
  }
  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .source {
    font-family: var(--font-mono);
    font-size: 12px;
  }
  .notice {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    background: var(--surface);
    padding: 13px 15px;
    border-radius: 9px;
    font-size: 12px;
    line-height: 1.8;
    margin-top: 20px;
    color: var(--muted);
  }
  .notice :global(svg) {
    flex-shrink: 0;
    margin-top: 3px;
  }
  .problem {
    color: var(--warning);
    background: var(--warning-soft);
  }
  .reading-area {
    margin-top: 24px;
  }
  h3 {
    font-size: 13px;
    font-weight: 600;
    margin: 0 0 14px;
  }
  .loading {
    display: flex;
    gap: 8px;
    align-items: center;
    min-height: 80px;
    color: var(--muted);
    font-size: 13px;
  }
  .skill-content {
    max-height: 55vh;
    overflow: auto;
    overscroll-behavior: contain;
    overflow-wrap: anywhere;
    padding: 0 12px 8px 0;
    font-size: 13px;
    line-height: 1.85;
    scrollbar-gutter: stable;
  }
  .skill-content :global(pre) {
    max-width: 100%;
    overflow: auto;
  }
  .skill-content :global(h1) {
    font-size: 22px;
  }
  .skill-content :global(h2) {
    font-size: 18px;
  }
  .skill-content :global(h3) {
    font-size: 15px;
  }
  @media (max-width: 600px) {
    .plugin-detail {
      padding: 20px;
    }
    .detail-heading {
      flex-wrap: wrap;
    }
    h2 {
      font-size: 20px;
    }
    dl {
      grid-template-columns: 68px minmax(0, 1fr);
      gap: 14px;
    }
  }
</style>
