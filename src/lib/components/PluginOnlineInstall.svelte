<!-- 查询与安装分开：模糊名称只能选包，安装必须使用核对后的精确版本。 -->
<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import { errorMessage } from '../client';
  import {
    npmIdentity,
    type pluginBridge,
    type PluginCatalog,
    type Plugin,
    type NpmPackage,
    type NpmSearch,
  } from '../plugins';
  let {
    api,
    projectItems = [],
    onbusy,
    ondirty,
    oninstalled,
    onview,
  }: {
    api: typeof pluginBridge;
    projectItems?: Plugin[];
    onbusy: (busy: boolean) => void;
    ondirty: (dirty: boolean) => void;
    oninstalled: (catalog: PluginCatalog) => void;
    onview: () => void;
  } = $props();
  let query = $state('');
  let result = $state<NpmSearch | null>(null);
  let selected = $state<NpmPackage | null>(null);
  let global = $state<PluginCatalog | null>(null);
  let searching = $state(false);
  let loading = $state(false);
  let installing = $state(false);
  let checking = $state(false);
  let approved = $state(false);
  let verifiedAbsent = $state(false);
  let error = $state('');
  let catalogError = $state('');
  let message = $state('');
  let outcome = $state<'idle' | 'uncertain' | 'installed'>('idle');
  let generation = 0;
  let detailGeneration = 0;
  let input: HTMLInputElement;
  let detailHeading = $state<HTMLHeadingElement>();
  const projectDeclaration = $derived(
    projectItems.find(
      (p) =>
        p.kind === 'packages' &&
        p.scope === 'project' &&
        npmIdentity(p.id) === selected?.name,
    ),
  );
  const candidates = $derived(
    result ? [...(result.exact ? [result.exact] : []), ...result.items] : [],
  );
  const existing = $derived(
    global?.items.find(
      (p) =>
        p.kind === 'packages' &&
        p.scope === 'global' &&
        npmIdentity(p.id) === selected?.name,
    ),
  );
  const recognized = $derived(selected?.piPackage || selected?.piManifest);
  $effect(() => ondirty(!!query.trim() && outcome !== 'installed'));
  onMount(() => {
    input?.focus();
    void readGlobal();
  });
  onDestroy(() => {
    ++generation;
    ++detailGeneration;
  });
  async function readGlobal() {
    checking = true;
    catalogError = '';
    try {
      global = await api.catalog(null);
    } catch (e) {
      catalogError = `无法核对全局安装配置：${errorMessage(e)}`;
    } finally {
      checking = false;
    }
  }
  async function search() {
    if (!query.trim() || installing || outcome === 'uncertain') return;
    const token = ++generation;
    ++detailGeneration;
    searching = true;
    loading = false;
    result = null;
    selected = null;
    error = '';
    message = '';
    outcome = 'idle';
    try {
      const value = await api.search(query.trim());
      if (token === generation) result = value;
    } catch (e) {
      if (token === generation) error = errorMessage(e);
    } finally {
      if (token === generation) searching = false;
    }
  }
  async function select(item: NpmPackage) {
    if (installing || outcome === 'uncertain') return;
    const token = ++detailGeneration;
    selected = null;
    approved = false;
    error = '';
    message = '';
    outcome = 'idle';
    loading = true;
    try {
      const value = await api.package(item.name, item.version);
      if (token === detailGeneration) {
        selected = value;
        await tick();
        if (token === detailGeneration && detailHeading) {
          // 只移动插件页滚动容器，避免默认焦点滚动连带移动隐藏的后台对话。
          detailHeading.focus({ preventScroll: true });
          const scroller =
            detailHeading.closest<HTMLElement>('.plugins-scroll');
          if (scroller) {
            const zoom =
              Number.parseFloat(
                getComputedStyle(document.documentElement).zoom,
              ) || 1;
            scroller.scrollTop +=
              (detailHeading.getBoundingClientRect().top -
                scroller.getBoundingClientRect().top) /
                zoom -
              20;
          }
        }
      }
    } catch (e) {
      if (token === detailGeneration) error = errorMessage(e);
    } finally {
      if (token === detailGeneration) loading = false;
    }
  }
  /** 核对失败只允许重读，不能把一次成功或部分成功的安装隐式重放。 */
  async function verify() {
    verifiedAbsent = false;
    await readGlobal();
    if (catalogError) {
      message =
        '安装命令已结束，配置尚未核对。请重新读取全局配置，不要重复安装。';
      return;
    }
    const found = global?.items.some(
      (p) =>
        p.kind === 'packages' &&
        p.scope === 'global' &&
        npmIdentity(p.id) === selected?.name,
    );
    if (found) {
      error = '';
      outcome = 'installed';
      message = '已全局安装。已有会话请在空闲时重新加载，新连接会读取配置。';
      if (global) oninstalled(global);
    } else {
      verifiedAbsent = true;
      message =
        '全局配置中尚未找到该包，请先核对 Pi 配置及 npm 源设置，再决定是否重新安装。';
    }
  }
  async function install() {
    if (
      !selected ||
      installing ||
      !global ||
      existing ||
      (!recognized && !approved) ||
      outcome !== 'idle'
    )
      return;
    installing = true;
    onbusy(true);
    error = '';
    message = '正在全局安装，请勿重复提交…';
    outcome = 'uncertain';
    try {
      const response = await api.command(
        null,
        'install',
        `npm:${selected.name}@${selected.version}`,
      );
      if (!response.success) throw new Error(response.message);
      message = '安装命令已结束，正在核对全局配置…';
      await verify();
    } catch (e) {
      error = `${errorMessage(e)} 可能已发生部分变更；请核对配置，不会自动重试。`;
      message = '安装结果待核对。';
    } finally {
      installing = false;
      onbusy(false);
    }
  }
</script>

<section class="online-install" aria-label="在线安装插件">
  <div class="intro">
    <p class="eyebrow">NPM 插件目录</p>
    <h2>在线安装</h2>
    <p>按包名直达，或搜索你需要的 Pi 插件。</p>
    <span class="scope">全局 · 所有项目可用</span>
  </div>
  <form
    onsubmit={(event) => {
      event.preventDefault();
      void search();
    }}
  >
    <label for="npm-query">npm 包名或插件名称</label>
    <div class="query-row">
      <input
        id="npm-query"
        bind:this={input}
        bind:value={query}
        disabled={installing || outcome === 'uncertain'}
        placeholder="例如 @example/pi-tools 或代码审阅"
        autocomplete="off"
        spellcheck="false"
      />
      <button
        class="primary"
        disabled={!query.trim() || installing || outcome === 'uncertain'}
        type="submit">{searching ? '重新查找' : '查找'}</button
      >
    </div>
    <p class="hint">
      支持包名、@组织/包名、精确版本或 npm 标签；请输入名称，无需 npm / npx
      命令。
    </p>
  </form>
  {#if error}<p class="feedback error" role="alert">{error}</p>{/if}
  {#if catalogError}<div class="feedback" role="alert">
      <p>{catalogError}</p>
      <button
        disabled={installing || checking}
        onclick={() =>
          outcome === 'uncertain' ? void verify() : void readGlobal()}
        >重新读取全局配置</button
      >
    </div>{/if}
  {#if message}<p class="feedback" role="status">{message}</p>{/if}
  {#if outcome === 'uncertain' && !installing && !catalogError}<button
      disabled={checking}
      onclick={() => void verify()}>重新读取全局配置</button
    >{/if}
  {#if verifiedAbsent && !installing && !checking && !catalogError}<button
      onclick={() => {
        outcome = 'idle';
        selected = null;
        verifiedAbsent = false;
        error = '';
        message = '';
      }}>重新选择安装包</button
    >{/if}
  {#if searching}<p role="status" class="hint">正在查询公开 npm…</p>{/if}
  {#if result}
    {#each result.warnings as warning}<p class="feedback" role="status">
        {warning}
      </p>{/each}
    <div class="results-heading">
      <h3>查找结果</h3>
      <span>{candidates.length} 个包</span>
    </div>
    {#if candidates.length === 0}<div class="empty">
        <h3>没有找到匹配的 Pi 插件</h3>
        <p>试试准确的 npm 包名，或换一个关键词。</p>
      </div>{/if}
    <ul aria-label="可安装的插件包">
      {#each candidates as item (item.name)}
        <li>
          <button
            class:chosen={selected?.name === item.name}
            aria-pressed={selected?.name === item.name}
            disabled={installing || outcome === 'uncertain'}
            onclick={() => void select(item)}
          >
            <span class="package-title"
              >{item.name}<span class="version">{item.version}</span></span
            >
            <span class="description">{item.description || '暂无简介'}</span>
            <span class="hint"
              >{result.exact?.name === item.name
                ? '准确匹配 · '
                : ''}{item.publisher
                ? `发布者：${item.publisher}`
                : '发布者信息未提供'}</span
            >
          </button>
        </li>
      {/each}
    </ul>
  {/if}
  {#if loading}<p class="feedback" role="status">正在核对包信息与版本…</p>{/if}
  {#if selected}<section class="package-detail" aria-label="安装包详情">
      <h3 bind:this={detailHeading} tabindex="-1">{selected.name}</h3>
      <p>{selected.description || '暂无简介'}</p>
      <dl>
        <dt>安装范围</dt>
        <dd>全局 · 所有项目可用</dd>
        <dt>安装版本</dt>
        <dd>{selected.version}（固定版本）</dd>
        <dt>来源</dt>
        <dd>registry.npmjs.org</dd>
        <dt>发布者</dt>
        <dd>{selected.publisher || '未提供'}</dd>
      </dl>
      {#if !recognized}<div class="feedback">
          <p>
            尚未确认这是 Pi 插件包。请核对包文档，普通 npm 工具不一定能被 Pi
            加载。
          </p>
          <label class="approval"
            ><input
              type="checkbox"
              bind:checked={approved}
              disabled={installing}
            />已确认该包适用于 Pi</label
          >
        </div>{/if}
      {#if projectDeclaration}<p class="hint">
          此包已有项目配置；全局安装不会移除项目的版本或覆盖设置。
        </p>{/if}
      <p class="hint">
        第三方包可能执行代码和安装脚本，请确认来源可信。发布者信息不代表安全认证。
      </p>
      {#if outcome === 'installed'}<button
          class="primary"
          disabled={installing || checking}
          onclick={onview}>查看已安装包</button
        >
      {:else if existing}<p class="feedback">已全局安装：{existing.id}</p>
        <button onclick={onview}>管理已安装包</button>
      {:else}<button
          class="primary"
          disabled={installing ||
            checking ||
            !global ||
            !!catalogError ||
            (!recognized && !approved) ||
            outcome !== 'idle'}
          onclick={() => void install()}
          >{installing ? '正在安装…' : '全局安装'}</button
        >{/if}
    </section>{/if}
</section>

<style>
  .online-install {
    max-width: 820px;
    margin: 0 auto;
    min-width: 0;
  }
  .intro {
    margin-bottom: 28px;
  }
  h2 {
    font-size: 23px;
    margin: 4px 0 8px;
  }
  h3 {
    font-size: 15px;
    margin: 0;
    overflow-wrap: anywhere;
  }
  p {
    margin: 8px 0;
  }
  .intro p,
  .hint,
  .description,
  dt,
  .results-heading span {
    color: var(--muted);
  }
  .eyebrow {
    font-size: 11px;
    letter-spacing: 0.08em;
  }
  .scope {
    display: inline-block;
    margin-top: 10px;
    padding: 5px 9px;
    background: var(--accent-soft);
    color: var(--accent);
    border-radius: 6px;
    font-size: 12px;
  }
  form label {
    display: block;
    font-weight: 600;
    margin-bottom: 8px;
  }
  .query-row {
    display: flex;
    gap: 8px;
  }
  .query-row input {
    flex: 1;
    width: 0;
  }
  .hint {
    font-size: 12px;
    overflow-wrap: anywhere;
  }
  .feedback {
    background: var(--surface);
    border: 1px solid var(--border);
    padding: 14px 16px;
    border-radius: 9px;
    margin: 16px 0;
    overflow-wrap: anywhere;
  }
  .error {
    color: var(--error);
  }
  .results-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin: 28px 0 8px;
  }
  .results-heading span {
    font-size: 12px;
  }
  ul {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  li {
    border-bottom: 1px solid var(--border);
  }
  li button {
    display: grid;
    gap: 6px;
    width: 100%;
    padding: 16px 12px;
    text-align: start;
    border: 1px solid transparent;
    border-radius: 6px;
  }
  li button.chosen {
    border-color: var(--accent);
    background: var(--accent-soft);
  }
  .package-title {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 16px;
    align-items: baseline;
    font-weight: 600;
    overflow-wrap: anywhere;
    min-width: 0;
  }
  .version {
    font-size: 12px;
    color: var(--muted);
    font-weight: 400;
  }
  .description {
    font-size: 13px;
    overflow-wrap: anywhere;
  }
  .package-detail {
    margin-top: 24px;
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 22px;
    overflow-wrap: anywhere;
  }
  dl {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 10px 20px;
    font-size: 13px;
    margin: 20px 0;
  }
  dd {
    margin: 0;
  }
  .approval {
    display: flex;
    align-items: start;
    gap: 8px;
    margin-top: 12px;
  }
  .approval input {
    margin-top: 4px;
  }
  .empty {
    padding: 32px 12px;
    color: var(--muted);
  }
  @media (max-width: 560px) {
    .package-detail {
      padding: 16px;
    }
    dl {
      gap: 8px 12px;
    }
  }
</style>
