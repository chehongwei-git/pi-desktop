<!-- 共享配置编辑草稿只在进入设置时加载；切换分类通过 hidden 保留组件与请求代次。 -->
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import type { Desktop } from '../state/desktop.svelte';
  import { errorMessage } from '../client';
  import {
    newProvider,
    thinkingLevels,
    type ModelSettings,
    type ProviderConfig,
    type Discovery,
  } from '../model-config';
  import ModelEditor from './ModelEditor.svelte';
  import SettingsSelect from './SettingsSelect.svelte';
  import { thinkingLabels } from '../model-config';
  let {
    desktop,
    dirty = $bindable(false),
    busy = $bindable(false),
  }: { desktop: Desktop; dirty?: boolean; busy?: boolean } = $props();
  let config = $state<ModelSettings | null>(null);
  let baseline = $state('');
  let error = $state('');
  let loaded = $state(false);
  let selected = $state('');
  let newId = $state('');
  let endpointSearch = $state('');
  let adding = $state(false);
  // 只展示显式端点；隐藏的 CLI 服务商仍留在快照中，无损保存。
  const endpoints = $derived(
    config?.providers.filter((p) => !p.removed && p.baseUrl !== null) ?? [],
  );
  const filteredEndpoints = $derived(
    endpoints.filter((p) =>
      `${p.name ?? ''} ${p.id} ${p.baseUrl}`
        .toLowerCase()
        .includes(endpointSearch.toLowerCase()),
    ),
  );
  let search = $state('');
  let remote = $state<Discovery | null>(null);
  let chosen = $state<string[]>([]);
  let discovering = $state(false);
  let discoveryError = $state('');
  let discoverySignature = $state('');
  let request = 0;
  let confirmReload = $state(false);
  let confirmRemove = $state(false);
  let modelSearch = $state('');
  let visibleCount = $state(30);
  let remoteCount = $state(50);
  const provider = $derived(
    config?.providers.find((p) => p.id === selected && !p.removed),
  );
  const signature = $derived(
    provider
      ? JSON.stringify([
          provider.id,
          provider.api,
          provider.baseUrl,
          provider.credential,
        ])
      : '',
  );
  const remoteFiltered = $derived(
    (remote?.models ?? []).filter((m) =>
      `${m.id} ${m.name}`.toLowerCase().includes(search.toLowerCase()),
    ),
  );
  const configured = $derived(
    provider?.models.filter(
      (m) =>
        !m.overrideOnly &&
        `${m.id} ${m.values.name ?? ''}`
          .toLowerCase()
          .includes(modelSearch.toLowerCase()),
    ) ?? [],
  );

  const allModels = $derived.by(() => {
    const map = new Map<
      string,
      { provider: string; id: string; name: string }
    >();
    for (const p of config?.providers ?? [])
      if (!p.removed && p.baseUrl !== null)
        for (const m of p.models.filter((m) => !m.overrideOnly))
          map.set(`${p.id}/${m.id}`, {
            provider: p.id,
            id: m.id,
            name: m.values.name || m.id,
          });
    return [...map.values()];
  });
  $effect(() => {
    dirty = !!config && JSON.stringify(config) !== baseline;
  });
  onMount(() => {
    void load();
  });
  onDestroy(() => {
    request++;
  });
  async function load() {
    if (busy) return;
    busy = true;
    error = '';
    try {
      const value = await desktop.loadModelConfig();
      config = value;
      baseline = JSON.stringify(value);
      loaded = true;
      selected =
        value.providers.find((p) => !p.removed && p.baseUrl !== null)?.id ?? '';
      remote = null;
      chosen = [];
      confirmReload = false;
    } catch (e) {
      error = errorMessage(e);
    } finally {
      busy = false;
    }
  }
  export async function save(): Promise<boolean> {
    if (!config || busy) return false;
    const incomplete = endpoints.find(
      (p) =>
        !p.baseUrl?.trim() ||
        ![
          'openai-completions',
          'openai-responses',
          'anthropic-messages',
        ].includes(p.api ?? ''),
    );
    if (incomplete) {
      select(incomplete.id);
      error = '请为自定义端点填写完整的 API 基础地址并选择协议。';
      return false;
    }
    busy = true;
    error = '';
    try {
      const value = await desktop.saveModelConfig($state.snapshot(config));
      config = value;
      baseline = JSON.stringify(value);
      return true;
    } catch (e) {
      error = errorMessage(e);
      return false;
    } finally {
      busy = false;
    }
  }
  function select(id: string) {
    request++;
    discovering = false;
    selected = id;
    remote = null;
    chosen = [];
    discoveryError = '';
    confirmRemove = false;
    modelSearch = '';
    visibleCount = 30;
  }
  function addProvider() {
    const id = newId.trim();
    if (!/^[a-zA-Z0-9_.-]{1,128}$/.test(id)) {
      error = '端点标识仅支持字母、数字、点、横线和下划线。';
      return;
    }
    if (config?.providers.some((p) => p.id === id)) {
      error = '此标识已被 CLI 配置使用，请使用独立的自定义端点标识。';
      return;
    }
    const endpoint = newProvider(id);
    endpoint.name = id;
    endpoint.baseUrl = '';
    endpoint.api = 'openai-completions';
    config?.providers.push(endpoint);
    adding = false;
    newId = '';
    select(id);
    error = '';
  }
  function addModel(id = '', name?: string) {
    const overrideOnly = false;
    if (!provider) return;
    if (
      id &&
      provider.models.some(
        (m) => m.id === id && m.overrideOnly === overrideOnly,
      )
    )
      return;
    provider.models.push({
      id,
      overrideOnly,
      // 默认关闭时同时关闭能力，指定强度后再启用。
      values: {
        ...(name ? { name } : {}),
        reasoning: false,
        input: ['text', 'image'],
      },
      defaultThinking: 'off',
    });
    visibleCount = provider.models.length;
  }
  async function discover() {
    if (!provider || discovering) return;
    const generation = ++request;
    const initialSignature = signature;
    discovering = true;
    discoveryError = '';
    remote = null;
    chosen = [];
    remoteCount = 50;
    try {
      const result = await desktop.discoverModels($state.snapshot(provider));
      if (generation !== request || initialSignature !== signature) return;
      remote = result;
      discoverySignature = initialSignature;
    } catch (e) {
      if (generation === request) discoveryError = errorMessage(e);
    } finally {
      if (generation === request) discovering = false;
    }
  }
  function cancelDiscovery() {
    request++;
    discovering = false;
    discoveryError = '已取消等待结果。';
  }
  function setDefault(value: string) {
    if (!config) return;
    const model = allModels.find((m) => `${m.provider}/${m.id}` === value);
    config.defaultProvider = model?.provider ?? null;
    config.defaultModel = model?.id ?? null;
  }
</script>

<div class="model-settings">
  <p>
    添加自定义 API 端点，获取模型后配置能力与思考等级。配置与本机 Pi CLI 共用。
  </p>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if !loaded}<button type="button" disabled={busy} onclick={load}
      >{busy ? '读取中…' : '重新读取配置'}</button
    >{/if}
  {#if config}
    <fieldset disabled={busy}>
      <details class="card defaults">
        <summary>新会话默认值</summary>
        <label
          >默认模型<select
            value={config.defaultProvider && config.defaultModel
              ? `${config.defaultProvider}/${config.defaultModel}`
              : ''}
            onchange={(e) => setDefault(e.currentTarget.value)}
            ><option value="">由 Pi 自动选择</option>
            {#if config.defaultProvider && config.defaultModel && !allModels.some((m) => m.provider === config?.defaultProvider && m.id === config?.defaultModel)}<option
                value={`${config.defaultProvider}/${config.defaultModel}`}
                >{config.defaultProvider}/{config.defaultModel}（已有配置）</option
              >{/if}
            {#each allModels as model}<option
                value={`${model.provider}/${model.id}`}
                >{model.provider} / {model.name}</option
              >{/each}
          </select></label
        >
        <SettingsSelect
          label="全局默认思考等级"
          value={config.defaultThinkingLevel}
          options={[
            { value: null, label: '继承 Pi 默认（关闭 · off）' },
            ...thinkingLevels.map((level) => ({
              value: level,
              label: thinkingLabels[level],
            })),
          ]}
          onchange={(value) => {
            if (config) config.defaultThinkingLevel = value;
          }}
        />
        <p>
          模型会限制实际可用等级。修改默认值不会切换当前会话；现有 Pi
          进程可能需要重新连接以读取启动默认值。
        </p>
      </details>
      <div class="endpoint-layout">
        <section class="endpoint-list" aria-label="自定义端点">
          <div class="row">
            <h3>自定义端点 <small>{endpoints.length}</small></h3>
            <button type="button" onclick={() => (adding = !adding)}
              >添加端点</button
            >
          </div>
          <label
            >搜索端点<input
              type="search"
              bind:value={endpointSearch}
              placeholder="名称或地址"
            /></label
          >
          {#if adding}<div class="new-endpoint">
              <label
                >端点标识<input
                  bind:value={newId}
                  placeholder="my-proxy"
                /></label
              >
              <div class="row">
                <button type="button" onclick={addProvider}>创建端点</button
                ><button type="button" onclick={() => (adding = false)}
                  >取消</button
                >
              </div>
            </div>{/if}
          <div class="endpoint-items">
            {#each filteredEndpoints as endpoint}<button
                type="button"
                class="endpoint-item"
                class:active={selected === endpoint.id}
                aria-pressed={selected === endpoint.id}
                onclick={() => select(endpoint.id)}
                ><strong>{endpoint.name || endpoint.id}</strong><small
                  >{endpoint.baseUrl || '待填写 API 地址'}</small
                ><small
                  >{endpoint.models.filter((m) => !m.overrideOnly).length} 个模型</small
                ></button
              >{/each}
            {#if !endpoints.length}<p>
                还没有自定义端点。添加一个 API 地址开始配置。
              </p>{:else if !filteredEndpoints.length}<p>
                没有匹配的端点。
              </p>{/if}
          </div>
          {#each config.providers.filter((p) => p.removed) as removed}<p>
              {removed.id} 待移除
              <button type="button" onclick={() => (removed.removed = false)}
                >撤销移除</button
              >
            </p>{/each}
        </section>
        <div class="endpoint-detail">
          {#if provider}
            <section class="card">
              <h3>{provider.name || provider.id}</h3>
              <p>连接配置 · {provider.id}</p>
              <div class="grid">
                <label
                  >显示名称<input
                    value={provider.name ?? ''}
                    oninput={(e) =>
                      provider &&
                      (provider.name = e.currentTarget.value || null)}
                  /></label
                >
                <SettingsSelect
                  label="API 协议"
                  value={provider.api}
                  options={[
                    { value: null, label: '选择协议', disabled: true },
                    {
                      value: 'openai-completions',
                      label: 'OpenAI Chat Completions',
                    },
                    { value: 'openai-responses', label: 'OpenAI Responses' },
                    {
                      value: 'anthropic-messages',
                      label: 'Anthropic Messages',
                    },
                    ...(provider.api &&
                    ![
                      'openai-completions',
                      'openai-responses',
                      'anthropic-messages',
                    ].includes(provider.api)
                      ? [
                          {
                            value: provider.api,
                            label: provider.api + '（已有配置）',
                          },
                        ]
                      : []),
                  ]}
                  onchange={(value) => {
                    if (provider) provider.api = value;
                  }}
                />
              </div>
              <label
                >API 基础地址<input
                  type="url"
                  value={provider.baseUrl ?? ''}
                  placeholder={provider.api === 'anthropic-messages'
                    ? 'https://api.example.com'
                    : 'https://api.example.com/v1'}
                  oninput={(e) =>
                    provider && (provider.baseUrl = e.currentTarget.value)}
                /></label
              >
              <p>
                {#if provider.api === 'anthropic-messages'}
                  填写服务端基础地址，无需添加版本路径。
                {:else}
                  填写完整 API 地址（包含路径前缀），例如 /v1。
                {/if}
                获取模型将请求该地址下的 /models。
              </p>
              <div class="authentication">
                <label
                  >API Key<input
                    type="password"
                    autocomplete="new-password"
                    value={provider.credential.value}
                    placeholder="输入 API Key；留空保留已有认证"
                    oninput={(e) => {
                      if (!provider) return;
                      // 空输入只表示不替换，避免编辑或清空草稿时误删已保存凭据。
                      provider.credential.value = e.currentTarget.value;
                      provider.credential.action = e.currentTarget.value
                        ? 'replace'
                        : 'keep';
                      provider.credential.confirmReplace = false;
                    }}
                  /></label
                >
                <p>
                  已有认证：{provider.credentialSource}。已保存的密钥不会回显。
                </p>
                {#if provider.credentialSource === 'OAuth' && provider.credential.action === 'replace'}<label
                    class="check"
                    ><input
                      type="checkbox"
                      bind:checked={provider.credential.confirmReplace}
                    />确认使用 API Key 替换已有 OAuth 认证，影响 CLI 后续请求</label
                  >{/if}
              </div>
              <div class="row discovery-actions">
                <button
                  type="button"
                  disabled={discovering ||
                    !provider.baseUrl?.trim() ||
                    !provider.api}
                  onclick={discover}
                  >{discovering ? '正在获取…' : '获取远端模型'}</button
                >{#if discovering}<button
                    type="button"
                    onclick={cancelDiscovery}>取消等待</button
                  >{/if}
              </div>
              {#if discoveryError}<p class="error" role="alert">
                  {discoveryError}
                </p>{/if}
              {#if remote}
                {#if discoverySignature !== signature}<p role="status">
                    连接配置已更改，请重新获取模型。
                  </p>{:else}
                  <p role="status">
                    已获取 {remote.models.length} 个模型{remote.truncated
                      ? '，结果达到上限或未完整分页'
                      : ''}。列表成功不代表所有模型支持当前协议。
                  </p>
                  <label
                    >搜索远端模型<input
                      bind:value={search}
                      oninput={() => (remoteCount = 50)}
                    /></label
                  >
                  <div class="row">
                    <button
                      type="button"
                      onclick={() =>
                        (chosen = [
                          ...new Set([
                            ...chosen,
                            ...remoteFiltered.map((m) => m.id),
                          ]),
                        ])}>选择搜索结果</button
                    ><button type="button" onclick={() => (chosen = [])}
                      >清空选择</button
                    >
                  </div>
                  <div class="remote-list">
                    {#each remoteFiltered.slice(0, remoteCount) as model}<label
                        class="check"
                        ><input
                          type="checkbox"
                          value={model.id}
                          bind:group={chosen}
                        /><span
                          >{model.name}<small
                            >{model.id}{provider.models.some(
                              (m) => m.id === model.id,
                            )
                              ? ' · 已配置'
                              : ''}</small
                          ></span
                        ></label
                      >{/each}
                  </div>
                  {#if remoteFiltered.length > remoteCount}<button
                      type="button"
                      onclick={() => (remoteCount += 50)}>显示更多模型</button
                    >{/if}
                  <button
                    type="button"
                    disabled={!chosen.length}
                    onclick={() => {
                      for (const model of remote?.models ?? [])
                        if (chosen.includes(model.id))
                          addModel(model.id, model.name);
                      chosen = [];
                    }}>添加所选模型到草稿</button
                  >
                {/if}
              {/if}
            </section>
            <section class="card">
              <h3>模型与能力</h3>
              <p>
                新模型默认关闭思考；指定强度后启用思考能力并应用对应强度。
                所有模型默认支持图片输入；上下文和输出长度继承 Pi
                默认。再次获取不会覆盖已有参数。
              </p>
              {#if !configured.length}<p class="empty-models">
                  尚未配置模型。获取远端列表或手动添加模型 ID。
                </p>{/if}
              <label
                >搜索已配置模型<input
                  bind:value={modelSearch}
                  oninput={() => (visibleCount = 30)}
                /></label
              >
              {#each configured.slice(0, visibleCount) as model}
                {#if remote && discoverySignature === signature && !remote.models.some((m) => m.id === model.id)}<p
                  >
                    {model.id}：本次远端列表未返回，配置仍保留。
                  </p>{/if}
                <ModelEditor
                  bind:model={provider.models[provider.models.indexOf(model)]}
                  globalThinking={config.defaultThinkingLevel}
                  effectiveInput={desktop.models.find(
                    (item) =>
                      item.provider === provider.id && item.id === model.id,
                  )?.input ??
                    (desktop.snapshot.model?.provider === provider.id &&
                    desktop.snapshot.model?.id === model.id
                      ? desktop.snapshot.model.input
                      : undefined)}
                  onremove={() => {
                    if (provider)
                      provider.models = provider.models.filter(
                        (m) => m !== model,
                      );
                  }}
                />
              {/each}
              {#if configured.length > visibleCount}<button
                  type="button"
                  onclick={() => (visibleCount += 30)}
                  >显示更多已配置模型</button
                >{/if}
              <button
                type="button"
                onclick={() => {
                  modelSearch = '';
                  addModel();
                }}>手动添加模型</button
              >
            </section>
            <section class="card">
              {#if confirmRemove}<p>
                  移除端点 {provider.id} 的本地配置及模型默认等级，不会删除远端模型。
                </p>
                <label class="check"
                  ><input
                    type="checkbox"
                    bind:checked={provider.clearCredential}
                  />同时清除保存的认证（包括 OAuth）</label
                >
                <div class="row">
                  <button type="button" onclick={() => (confirmRemove = false)}
                    >保留</button
                  ><button
                    type="button"
                    onclick={() => {
                      if (provider) provider.removed = true;
                      select('');
                    }}>确认加入待移除列表</button
                  >
                </div>{:else}<button
                  type="button"
                  onclick={() => (confirmRemove = true)}
                  >移除此端点的本地配置</button
                >{/if}
            </section>
          {:else}<section class="card empty-detail">
              <h3>选择或添加端点</h3>
              <p>每个端点包含 API 地址、认证信息和可用模型。</p>
            </section>{/if}
        </div>
      </div>
    </fieldset>
    <details class="shared-config">
      <summary>共享配置与高级说明</summary>
      <p class="directory">共享配置目录：{config.directory}</p>
      <p>
        这里只管理自定义端点。其他 CLI 服务商及已有模型覆盖保留在原配置中；OAuth
        登录继续由 CLI 管理。
      </p>
    </details>
    <div class="row">
      {#if confirmReload}<span>放弃当前模型配置草稿并重新读取？</span><button
          type="button"
          onclick={() => (confirmReload = false)}>保留草稿</button
        ><button type="button" disabled={busy} onclick={load}>放弃并读取</button
        >{:else}<button
          type="button"
          disabled={busy}
          onclick={() => (dirty ? (confirmReload = true) : void load())}
          >重新读取共享配置</button
        >{/if}
    </div>
    <p role="status">{desktop.modelConfigStatus}</p>
    {#if desktop.modelConfigPending}<button
        type="button"
        disabled={desktop.modelConfigApplying || desktop.run !== 'idle'}
        onclick={() => desktop.applyModelConfig()}>重试应用模型配置</button
      >{/if}
  {/if}
</div>

<style>
  .model-settings {
    font-size: 12px;
  }
  p {
    line-height: 1.7;
    color: var(--settings-muted, var(--text));
  }
  .directory {
    overflow-wrap: anywhere;
    font-size: 11px;
  }
  .card {
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 18px;
    margin: 16px 0;
  }
  h3 {
    font-size: 13px;
    margin: 0 0 12px;
  }
  fieldset {
    border: 0;
    padding: 0;
    min-width: 0;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 12px 0;
    min-width: 0;
  }
  input,
  select {
    width: 100%;
    min-width: 0;
    font-size: 12px;
  }
  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  }
  .endpoint-layout {
    display: grid;
    grid-template-columns: 190px minmax(0, 1fr);
    gap: 18px;
    align-items: start;
  }
  .endpoint-list {
    min-width: 0;
    padding-top: 16px;
  }
  .endpoint-list .row {
    justify-content: space-between;
  }
  .endpoint-list h3 {
    margin: 0;
  }
  .endpoint-list h3 small {
    display: inline;
  }
  .endpoint-items {
    display: grid;
    gap: 6px;
  }
  .endpoint-item {
    width: 100%;
    text-align: left;
    padding: 12px;
    border: 1px solid transparent;
    background: transparent;
    border-radius: 8px;
    overflow-wrap: anywhere;
  }
  .endpoint-item strong {
    display: block;
    margin-bottom: 5px;
  }
  .endpoint-item.active {
    background: var(--accent-soft);
    border-color: var(--accent);
  }
  .endpoint-detail {
    min-width: 0;
  }
  .endpoint-detail .card:first-child {
    margin-top: 16px;
  }
  .new-endpoint {
    padding: 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  summary {
    cursor: pointer;
    padding: 6px 0;
    font-weight: 500;
  }
  .authentication {
    margin: 16px 0;
    border-top: 1px solid var(--border);
    padding-top: 10px;
  }
  .defaults {
    margin-top: 0;
  }
  .shared-config {
    margin: 16px 0;
  }
  .empty-detail {
    min-height: 160px;
  }
  .discovery-actions {
    margin-top: 16px;
  }
  @media (max-width: 900px) {
    .endpoint-layout {
      grid-template-columns: 1fr;
    }
    .endpoint-items {
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    }
  }
  .check {
    flex-direction: row;
    align-items: center;
    min-height: 32px;
    gap: 10px;
    overflow-wrap: anywhere;
  }
  .check input {
    width: auto;
    flex-shrink: 0;
  }
  small {
    display: block;
    opacity: 0.7;
  }
  .remote-list {
    max-height: 320px;
    overflow: auto;
    margin: 12px 0;
  }
  .error {
    color: var(--error);
  }
  @media (max-width: 600px) {
    .grid {
      grid-template-columns: 1fr;
    }
  }
</style>
