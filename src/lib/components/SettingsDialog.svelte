<!-- 设置在主内容区编辑；连接配置在下次连接时生效。 -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { open } from '@tauri-apps/plugin-dialog';
  import Icon from './Icon.svelte';
  import ModelSettings from './ModelSettings.svelte';
  import type { Desktop } from '../state/desktop.svelte';
  import { errorMessage } from '../client';

  let { desktop, onclose }: { desktop: Desktop; onclose: () => void } =
    $props();
  // 只在进入设置时取快照，避免外部刷新覆盖编辑中的草稿。
  const initial = initialSettings();
  function initialSettings() {
    return structuredClone($state.snapshot(desktop.settings));
  }
  let form = $state(structuredClone(initial));
  let paths = $state(initial.extraPath.join('\n'));
  let section = $state('appearance');
  let modelsPage = $state<ModelSettings>();
  let modelsVisited = $state(false);
  let modelsDirty = $state(false);
  let modelsBusy = $state(false);
  let busy = $state<'detect' | 'save' | null>(null);
  let diagnostic = $state('');
  let failed = $state(false);
  let status = $state('');
  let confirmLeave = $state(false);
  let heading: HTMLHeadingElement;
  const sections = [
    {
      id: 'appearance',
      label: '外观',
      icon: 'panel',
      description: '让工作空间更合你的习惯。',
    },
    {
      id: 'connection',
      label: 'Pi 连接',
      icon: 'pi',
      description: '连接本机 Pi，配置启动环境。',
    },
    {
      id: 'models',
      label: '模型与服务商',
      icon: 'pi',
      description: '管理自定义 API 端点、模型与思考等级。',
    },
    {
      id: 'storage',
      label: '会话与存储',
      icon: 'folder',
      description: '管理会话历史的读取位置。',
    },
  ];
  const themes = [
    { id: 'system', label: '跟随系统' },
    { id: 'light', label: '浅色' },
    { id: 'dark', label: '深色' },
  ] as const;
  let dirty = $derived(
    form.piPath !== initial.piPath ||
      form.runtimePath !== initial.runtimePath ||
      form.sessionDir !== initial.sessionDir ||
      form.theme !== initial.theme ||
      paths !== initial.extraPath.join('\n'),
  );
  onMount(() => heading?.focus({ preventScroll: true }));

  let pendingLeave = $state<(() => void) | null>(null);
  /** 返回与侧栏导航共用未保存保护，确认后执行用户选择的目的地。 */
  export function requestLeave(action: () => void = onclose): void {
    if (busy || modelsBusy) return;
    if (dirty || modelsDirty) {
      pendingLeave = action;
      confirmLeave = true;
    } else action();
  }
  function close(): void {
    requestLeave();
  }
  function discard(): void {
    const action = pendingLeave ?? onclose;
    pendingLeave = null;
    confirmLeave = false;
    action();
  }
  function keydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && !event.defaultPrevented) {
      event.preventDefault();
      if (confirmLeave) confirmLeave = false;
      else close();
    }
  }
  async function browse(field: 'piPath' | 'runtimePath' | 'sessionDir') {
    if (busy) return;
    try {
      const result = await open({
        directory: field === 'sessionDir',
        multiple: false,
      });
      if (typeof result === 'string') form[field] = result;
    } catch (error) {
      failed = true;
      diagnostic = errorMessage(error);
    }
  }
  function value() {
    return {
      ...$state.snapshot(desktop.settings),
      piPath: form.piPath,
      runtimePath: form.runtimePath,
      sessionDir: form.sessionDir,
      theme: form.theme,
      extraPath: paths
        .split('\n')
        .map((path) => path.trim())
        .filter(Boolean),
    };
  }
  async function detect() {
    if (busy) return;
    busy = 'detect';
    diagnostic = '';
    status = '';
    failed = false;
    try {
      const result = await desktop.detect(value());
      diagnostic = `Pi ${result.version}\n${result.spec.executable}\n${result.spec.args.join('\n')}\n${result.verified ? '已验证基线' : '未经本版验证，将探测 RPC 能力'}`;
    } catch (error) {
      failed = true;
      diagnostic = errorMessage(error);
    } finally {
      busy = null;
    }
  }
  async function save() {
    if (busy || modelsBusy) return;
    if (modelsDirty && !(await modelsPage?.save())) return;
    if (section === 'models' && !dirty) return;
    busy = 'save';
    status = '';
    try {
      await desktop.saveSettings(value());
      desktop.notice = '设置已保存，启动配置在下次连接时生效。';
      if (!modelsVisited) onclose();
      else status = '桌面设置已保存。';
    } catch (error) {
      status = errorMessage(error);
    } finally {
      busy = null;
    }
  }
</script>

<svelte:window onkeydown={keydown} />
<section class="settings-page" aria-label="应用设置">
  <header class="page-header">
    <div>
      <p class="eyebrow">工作空间偏好</p>
      <h1 bind:this={heading} tabindex="-1">设置</h1>
      <p>为你的本地工作空间，做一点调整。</p>
    </div>
    <button
      class="return-button"
      disabled={!!busy || modelsBusy}
      onclick={close}><span aria-hidden="true">←</span> 返回对话</button
    >
  </header>
  <div class="settings-layout">
    <nav aria-label="设置分类">
      {#each sections as item}
        <button
          class:active={section === item.id}
          aria-current={section === item.id ? 'page' : undefined}
          onclick={() => {
            section = item.id;
            if (section === 'models') modelsVisited = true;
          }}><Icon name={item.icon} size={18} />{item.label}</button
        >
      {/each}
      <div class="local-note">
        <Icon name="pi" size={21} /><strong>本地运行，由你掌控</strong>
        <p>偏好保存在这台设备上。</p>
        {#if desktop.version}<span>Pi {desktop.version}</span>{/if}
      </div>
    </nav>
    <div class="settings-content">
      <div class="section-heading">
        <h2>{sections.find((item) => item.id === section)?.label}</h2>
        <p>{sections.find((item) => item.id === section)?.description}</p>
      </div>
      {#if modelsVisited}
        <div hidden={section !== 'models'}>
          <ModelSettings
            bind:this={modelsPage}
            {desktop}
            bind:dirty={modelsDirty}
            bind:busy={modelsBusy}
          />
        </div>
      {/if}
      <fieldset disabled={!!busy} hidden={section === 'models'}>
        {#if section === 'appearance'}
          <div class="settings-card">
            <div class="card-heading">
              <h3>界面主题</h3>
              <p id="theme-help">选择喜欢的明暗风格，保存后应用。</p>
            </div>
            <div
              class="theme-options"
              role="radiogroup"
              aria-label="外观"
              aria-describedby="theme-help"
            >
              {#each themes as theme}
                <label
                  class="theme-option"
                  class:selected={form.theme === theme.id}
                >
                  <input
                    type="radio"
                    name="theme"
                    value={theme.id}
                    bind:group={form.theme}
                  />
                  <span
                    class="theme-preview"
                    class:preview-dark={theme.id === 'dark'}
                    class:preview-system={theme.id === 'system'}
                    aria-hidden="true"
                    ><span class="preview-sidebar"></span><span
                      class="preview-body"><i></i><i></i><span></span></span
                    ></span
                  >
                  <span class="theme-caption"
                    >{theme.label}<span class="radio-mark" aria-hidden="true"
                      >{form.theme === theme.id ? '●' : '○'}</span
                    ></span
                  >
                </label>
              {/each}
            </div>
          </div>
          <div class="settings-card compact-card">
            <div>
              <h3>界面缩放</h3>
              <p>使用快捷键调整文字与界面大小。</p>
            </div>
            <strong class="zoom-value">{desktop.settings.zoom}%</strong>
            <div class="shortcut-hint">
              <kbd>Ctrl / ⌘</kbd><span>+</span><kbd>+ / −</kbd><span>调整</span
              ><kbd>0</kbd><span>重置</span>
            </div>
          </div>
        {:else if section === 'connection'}
          <div class="connection-note">
            <Icon name="info" size={18} />
            <p>
              连接本机已有 Pi。API Key 和模型参数可在“模型与服务商”中配置；OAuth
              登录仍由 Pi CLI 管理。
            </p>
          </div>
          <div class="settings-card fields">
            <div class="field">
              <label for="pi-path">Pi 入口路径 <span>可选</span></label>
              <p id="pi-help">留空自动发现，也可指定可执行文件或 CLI 脚本。</p>
              <div class="path-row">
                <input
                  id="pi-path"
                  aria-describedby="pi-help"
                  bind:value={form.piPath}
                  placeholder="pi.exe / pi.cmd / cli.js / pi"
                /><button
                  aria-label="浏览 Pi 入口路径"
                  onclick={() => browse('piPath')}>浏览</button
                >
              </div>
            </div>
            <div class="field">
              <label for="runtime-path"
                >Node / Bun 运行时 <span>可选</span></label
              >
              <p id="runtime-help">使用脚本入口时，可指定运行时路径。</p>
              <div class="path-row">
                <input
                  id="runtime-path"
                  aria-describedby="runtime-help"
                  bind:value={form.runtimePath}
                  placeholder="自动查找 Node"
                /><button
                  aria-label="浏览运行时"
                  onclick={() => browse('runtimePath')}>浏览</button
                >
              </div>
            </div>
            <div class="field">
              <label for="extra-path">额外 PATH 目录 <span>可选</span></label>
              <p id="path-help">
                每行一个，仅对 Pi
                子进程生效。桌面找不到终端中的命令时可在此补充。
              </p>
              <textarea
                id="extra-path"
                aria-describedby="path-help"
                bind:value={paths}
                rows="3"
                placeholder="输入需要补充的目录"></textarea>
            </div>
          </div>
          <div class="detect-row">
            <div>
              <h3>检查连接配置</h3>
              <p>检测版本与启动路径，使用当前未保存的配置。</p>
            </div>
            <button disabled={!!busy} onclick={detect}
              ><Icon name="refresh" size={15} />{busy === 'detect'
                ? '正在检测…'
                : '检测 Pi'}</button
            >
          </div>
        {:else}
          <div class="settings-card fields">
            <div class="field">
              <label for="session-dir">会话目录 <span>可选</span></label>
              <p id="session-help">
                留空使用 Pi 默认目录。保存后将刷新侧栏中的会话历史。
              </p>
              <div class="path-row">
                <input
                  id="session-dir"
                  aria-describedby="session-help"
                  bind:value={form.sessionDir}
                  placeholder="使用 Pi 默认目录"
                /><button
                  aria-label="浏览会话目录"
                  onclick={() => browse('sessionDir')}>浏览</button
                >
              </div>
            </div>
          </div>
          <div class="connection-note">
            <Icon name="info" size={18} />
            <p>更改读取目录不会移动或删除已有会话文件。</p>
          </div>
          <details class="capabilities">
            <summary>本地访问与兼容性说明</summary>
            <p>
              Pi 的工具可访问所选项目与本机资源。桌面界面的 IPC 限制不构成 Agent
              工具沙箱。TUI 自定义组件不会在桌面端仿真。
            </p>
          </details>
        {/if}
      </fieldset>
      {#if diagnostic}<div class="diagnostic-result" class:failed role="status">
          <strong>{failed ? '检测或路径选择未完成' : '检测完成'}</strong>
          <pre>{diagnostic}</pre>
        </div>{/if}
    </div>
  </div>
  <footer class="settings-footer">
    {#if confirmLeave}<div class="leave-confirm" role="status">
        <span>有未保存的更改，是否放弃？</span><button
          onclick={() => {
            confirmLeave = false;
            pendingLeave = null;
          }}>继续编辑</button
        ><button onclick={discard}
          >{pendingLeave ? '放弃并继续' : '放弃并返回'}</button
        >
      </div>
    {:else}<div class="save-hint" role="status">
        {#if status}<span class="error-text">{status}</span>{:else}{dirty ||
          modelsDirty
            ? '有未保存的更改'
            : '设置保存在本机'}<small>连接配置在下次连接时生效</small>{/if}
      </div>
      <button class="primary" disabled={!!busy || modelsBusy} onclick={save}
        >{busy === 'save' || modelsBusy ? '处理中…' : '保存设置'}</button
      >{/if}
  </footer>
</section>

<style>
  .settings-page {
    --settings-muted: color-mix(in srgb, var(--text) 65%, var(--bg));
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    color: var(--text);
  }
  .page-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 20px;
    padding: 34px 40px 26px;
    border-bottom: 1px solid var(--border);
  }
  .eyebrow {
    color: var(--accent);
    font-size: 12px;
    letter-spacing: 0.04em;
    margin: 0 0 8px;
  }
  h1 {
    margin: 0;
    font-size: 28px;
    font-weight: 600;
    letter-spacing: 0;
  }
  p {
    color: var(--settings-muted);
    font-size: 13px;
    line-height: 1.7;
    margin: 6px 0 0;
  }
  button {
    font-size: 13px;
  }
  .return-button {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-shrink: 0;
  }
  .settings-layout {
    display: grid;
    grid-template-columns: 190px minmax(0, 1fr);
    flex: 1;
    min-height: 0;
    overflow: auto;
  }
  nav {
    padding: 26px 16px 24px 24px;
    border-right: 1px solid var(--border);
  }
  nav button {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 10px;
    text-align: left;
    border: 0;
    margin-bottom: 5px;
    min-height: 42px;
  }
  nav button.active {
    color: var(--accent);
    background: var(--accent-soft);
    font-weight: 600;
  }
  .local-note {
    margin: 40px 12px 0;
    color: var(--settings-muted);
  }
  .local-note strong {
    display: block;
    font-size: 12px;
    margin-top: 10px;
    font-weight: 500;
  }
  .local-note p,
  .local-note span {
    font-size: 12px;
  }
  .local-note span {
    display: block;
    margin-top: 14px;
  }
  .settings-content {
    padding: 30px 32px 40px;
    width: 100%;
    max-width: 820px;
    min-width: 0;
  }
  h2 {
    font-size: 19px;
    font-weight: 600;
    margin: 0;
  }
  .section-heading {
    margin-bottom: 24px;
  }
  h3 {
    font-size: 13px;
    font-weight: 600;
    margin: 0;
  }
  fieldset {
    border: 0;
    padding: 0;
    margin: 0;
    min-width: 0;
  }
  .settings-card {
    border: 1px solid var(--border);
    border-radius: var(--radius-panel);
    padding: 24px;
    margin-bottom: 18px;
  }
  .theme-options {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 12px;
    margin-top: 20px;
  }
  .theme-option {
    position: relative;
    cursor: pointer;
    min-width: 0;
    padding: 5px;
    border: 1px solid var(--border);
    border-radius: 9px;
  }
  .theme-option.selected {
    border-color: var(--accent);
    background: var(--accent-soft);
    box-shadow: 0 0 0 1px var(--accent);
  }
  .theme-option:focus-within {
    outline: 2px solid var(--accent);
    outline-offset: 4px;
  }
  .theme-option input {
    position: absolute;
    width: 1px;
    height: 1px;
    opacity: 0;
  }
  .theme-preview {
    display: flex;
    height: 86px;
    border: 1px solid #dedfd9;
    border-radius: 5px;
    overflow: hidden;
    background: #fff;
  }
  .preview-sidebar {
    width: 25%;
    background: #f0f1ed;
    border-right: 1px solid #dedfd9;
  }
  .preview-body {
    flex: 1;
    padding: 16px 10px 9px;
  }
  .preview-body i {
    display: block;
    height: 5px;
    border-radius: 4px;
    background: #dedfd9;
    width: 65%;
    margin-bottom: 8px;
  }
  .preview-body i:nth-child(2) {
    width: 90%;
  }
  .preview-body > span {
    display: block;
    height: 18px;
    background: #f0f1ed;
    border-radius: 5px;
    margin-top: 13px;
  }
  .preview-dark {
    background: #202124;
    border-color: #3b3e44;
  }
  .preview-dark .preview-sidebar,
  .preview-dark .preview-body > span {
    background: #2b2d31;
    border-color: #3b3e44;
  }
  .preview-dark i {
    background: #646b73;
  }
  .preview-system {
    background: linear-gradient(115deg, #fff 50%, #202124 50%);
  }
  .theme-caption {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 10px 4px 5px;
    font-size: 12px;
    gap: 4px;
  }
  .radio-mark {
    color: var(--accent);
    font-size: 15px;
  }
  .compact-card {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 16px;
  }
  .zoom-value {
    font-size: 14px;
    font-weight: 500;
  }
  .shortcut-hint {
    grid-column: 1/-1;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    font-size: 12px;
    color: var(--settings-muted);
  }
  kbd {
    font: inherit;
    padding: 4px 7px;
    background: var(--sidebar);
    border: 1px solid var(--border);
    border-radius: 5px;
  }
  .connection-note {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    padding: 14px 16px;
    background: var(--sidebar);
    border-radius: 9px;
    margin-bottom: 18px;
    color: var(--settings-muted);
  }
  .connection-note :global(svg) {
    flex-shrink: 0;
    margin-top: 3px;
  }
  .connection-note p {
    margin: 0;
  }
  .field + .field {
    border-top: 1px solid var(--border);
    padding-top: 20px;
    margin-top: 20px;
  }
  .field label {
    font-size: 13px;
    font-weight: 500;
  }
  .field label span {
    font-weight: 400;
    font-size: 12px;
    color: var(--settings-muted);
    margin-left: 6px;
  }
  .field p {
    font-size: 12px;
    margin-bottom: 10px;
  }
  .path-row {
    display: flex;
    gap: 8px;
  }
  .path-row input {
    flex: 1;
    width: 0;
  }
  input,
  textarea {
    font-size: 13px;
  }
  textarea {
    width: 100%;
    display: block;
    line-height: 1.7;
  }
  .detect-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
  }
  .detect-row button {
    display: flex;
    align-items: center;
    gap: 7px;
    flex-shrink: 0;
  }
  .detect-row p {
    font-size: 12px;
  }
  .diagnostic-result {
    margin-top: 18px;
    border: 1px solid var(--border);
    background: var(--sidebar);
    border-radius: 9px;
    padding: 14px;
    font-size: 13px;
  }
  .diagnostic-result.failed {
    color: var(--error);
  }
  pre {
    font-size: 12px;
    line-height: 1.7;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    margin: 8px 0 0;
  }
  .capabilities {
    font-size: 13px;
    color: var(--settings-muted);
    line-height: 1.7;
  }
  summary {
    cursor: pointer;
    padding: 8px 0;
  }
  .settings-footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 16px;
    padding: 18px 32px;
    border-top: 1px solid var(--border);
  }
  .save-hint {
    font-size: 13px;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .save-hint small {
    display: block;
    font-size: 12px;
    color: var(--settings-muted);
    margin-top: 5px;
  }
  .settings-footer > button {
    flex-shrink: 0;
    padding: 10px 20px;
  }
  .leave-confirm {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    font-size: 13px;
  }
  @media (max-width: 1100px) {
    .settings-layout {
      grid-template-columns: 145px minmax(0, 1fr);
    }
    nav {
      padding-left: 12px;
      padding-right: 12px;
    }
    .settings-content {
      padding: 26px 24px;
    }
    .page-header {
      padding: 28px 24px 24px;
    }
    .settings-card {
      padding: 18px;
    }
  }
  @media (max-width: 600px) {
    .page-header {
      padding: 24px 18px;
      align-items: flex-start;
    }
    .page-header > div > p:last-child {
      max-width: 180px;
    }
    h1 {
      font-size: 24px;
    }
    .settings-layout {
      display: flex;
      flex-direction: column;
    }
    nav {
      display: flex;
      gap: 4px;
      padding: 12px;
      border-right: 0;
      border-bottom: 1px solid var(--border);
    }
    nav button {
      justify-content: center;
      padding: 8px 6px;
      margin: 0;
      font-size: 12px;
    }
    nav button :global(svg) {
      display: none;
    }
    .local-note {
      display: none;
    }
    .settings-content {
      padding: 24px 18px;
    }
    .settings-card {
      padding: 16px;
    }
    .theme-options {
      gap: 8px;
    }
    .theme-preview {
      height: 68px;
    }
    .theme-caption {
      font-size: 12px;
      padding-left: 0;
      padding-right: 0;
    }
    .settings-footer {
      padding: 14px 18px;
    }
    .detect-row {
      align-items: flex-start;
      flex-wrap: wrap;
    }
  }
</style>
