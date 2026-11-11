<!-- 可控异步夹具：覆盖空/失败/加载及多项目选择，不接触用户配置。 -->
<script lang="ts">
  import PluginsPage from '../../src/lib/components/PluginsPage.svelte';
  import type { Plugin, PluginCatalog } from '../../src/lib/plugins';
  const seed: Plugin = {
    id: 'long-resource',
    kind: 'mcp',
    name: '内部文档与知识检索服务 · 较长名称用于窗口适配检查',
    description: '项目文档与开发资料的统一检索入口。',
    source: '配置目录/较长项目路径/文档服务/mcp.json',
    scope: 'global',
    enabled: true,
    inherited: true,
    overridden: false,
    problem: null,
  };
  let state = $state('normal');
  let release: (() => void) | undefined;
  const projects = Array.from({ length: 16 }, (_, i) => ({
    path: `project-${i}/团队工程/较长目录`,
    name: `工作项目 ${i}`,
  }));
  function catalog(): PluginCatalog {
    return {
      revision: 'r',
      directory: 'isolated',
      items: state === 'empty' ? [] : [seed],
      warnings: [],
    };
  }
  const api = {
    async catalog() {
      if (state === 'loading')
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      if (state === 'error')
        throw new Error('配置已被外部修改，请重新读取后再提交。');
      return catalog();
    },
    async change() {
      throw new Error('配置保存失败，输入仍已保留。');
    },
    async detail() {
      return '此资源来自本地配置。';
    },
    async command() {
      return {
        success: true,
        message: '独立检查结束，不代表会话实时连接状态。',
      };
    },
  };
</script>

<div class="fixture-controls">
  <button
    onclick={() => {
      state = 'empty';
    }}>空列表</button
  ><button
    onclick={() => {
      state = 'error';
    }}>读取失败</button
  ><button
    onclick={() => {
      state = 'loading';
    }}>延迟读取</button
  ><button
    onclick={() => {
      state = 'normal';
      release?.();
    }}>恢复正常</button
  >
</div>
<div style="height:calc(100vh - 50px);display:flex;min-height:0">
  <PluginsPage {projects} sessions={[]} onclose={() => {}} {api} />
</div>

<style>
  .fixture-controls {
    height: 50px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 20px;
    background: var(--surface);
  }
</style>
