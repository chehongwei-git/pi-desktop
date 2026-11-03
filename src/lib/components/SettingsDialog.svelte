<!-- 设置在主内容区编辑，具体生效时机在对应分类内说明。 -->
<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { open } from '@tauri-apps/plugin-dialog';
  import Icon from './Icon.svelte';
  import ModelSettings from './ModelSettings.svelte';
  import type { Desktop } from '../state/desktop.svelte';
  import { errorMessage } from '../client';

  let {
    desktop,
    onclose,
    unsaved = $bindable(false),
  }: {
    desktop: Desktop;
    onclose: () => void;
    unsaved?: boolean;
  } = $props();
  // 只在进入设置时取快照，避免外部刷新覆盖编辑中的草稿。
  const seed = initialSettings();
  let initial = $state(structuredClone(seed));
  function initialSettings() {
    return structuredClone($state.snapshot(desktop.settings));
  }
  let form = $state(structuredClone(seed));
  let paths = $state(seed.extraPath.join('\n'));
  let section = $state('appearance');
  let modelsPage = $state<ModelSettings>();
  let modelsVisited = $state(false);
  let modelsDirty = $state(false);
  let modelsBusy = $state(false);
  let busy = $state<'detect' | 'save' | null>(null);
  let diagnostic = $state('');
  let failed = $state(false);
  let status = $state('');
  /** 确认条内的保存失败说明，避免长文案在同一区域被覆盖。 */
  let saveError = $state('');
  /** 被导航拦下时保留目的地说明，让用户确认点击已被记录。 */
  let leaveTarget = $state('');
  /** 确认条出现前的焦点来源，取消后回到原处。 */
  let leaveReturnFocus: HTMLElement | null = null;
  let leavePrimary = $state<HTMLButtonElement | null>(null);
  let heading: HTMLHeadingElement;
  const leaveHeadingId = $props.id();
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
  // 分项标记让用户知道改在哪个分类，而不用逐页翻找。
  const changed = $derived({
    appearance: form.theme !== initial.theme,
    connection:
      form.piPath !== initial.piPath ||
      form.runtimePath !== initial.runtimePath ||
      paths !== initial.extraPath.join('\n'),
    models: modelsDirty,
    storage:
      form.sessionDir !== initial.sessionDir ||
      form.maxConcurrentTasks !== initial.maxConcurrentTasks ||
      form.idleProcessLimit !== initial.idleProcessLimit,
  });
  const changedList = $derived(
    sections.filter((item) => changed[item.id as keyof typeof changed]),
  );
  let dirty = $derived(changedList.length > 0);
  $effect(() => {
    unsaved = dirty;
  });
  onMount(() => heading?.focus({ preventScroll: true }));

  let pendingLeave = $state<(() => void) | null>(null);
  let confirmLeave = $state(false);
  let waitingForTask = $state(false);
  /** 返回与侧栏导航共用未保存保护，确认后执行用户选择的目的地。 */
  export function requestLeave(
    action: () => void = onclose,
    target = '返回对话',
  ): void {
    // 保存进行中也要给出反馈，不能静默吞掉导航点击。
    if (dirty || busy || modelsBusy) {
      pendingLeave = action;
      waitingForTask = !!busy || modelsBusy;
      leaveTarget = target;
      leaveReturnFocus =
        document.activeElement instanceof HTMLElement &&
        !leavePrimary?.contains(document.activeElement)
          ? document.activeElement
          : leaveReturnFocus;
      confirmLeave = true;
      void tick().then(() => leavePrimary?.focus({ preventScroll: true }));
      return;
    }
    cancelLeave();
    action();
  }
  function close(): void {
    requestLeave();
  }
  /** 取消离开：保留草稿并把焦点还给触发控件。 */
  async function keepEditing(): Promise<void> {
    const origin = leaveReturnFocus;
    cancelLeave();
    await tick();
    (origin?.isConnected ? origin : heading)?.focus({ preventScroll: true });
  }
  function cancelLeave(): void {
    pendingLeave = null;
    waitingForTask = false;
    leaveTarget = '';
    saveError = '';
    confirmLeave = false;
  }
  function discard(): void {
    const action = pendingLeave ?? onclose;
    cancelLeave();
    action();
  }
  function keydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && !event.defaultPrevented) {
      event.preventDefault();
      if (confirmLeave) {
        if (!busy && !modelsBusy) void keepEditing();
      } else close();
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
      maxConcurrentTasks: form.maxConcurrentTasks ?? 4,
      idleProcessLimit: form.idleProcessLimit ?? 5,
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
  /** 保存全部草稿；整段提交共用锁，防止模型与桌面设置交错提交。 */
  async function persist(): Promise<boolean> {
    if (busy || modelsBusy) return false;
    busy = 'save';
    saveError = '';
    status = '';
    try {
      if (modelsDirty && !(await modelsPage?.save())) {
        section = 'models';
        saveError = '模型配置未保存，请检查“模型与服务商”中的提示。';
        return false;
      }
      // 模型保存成功后仍可能有桌面配置失败，只更新已落盘部分的基线。
      if (changed.appearance || changed.connection || changed.storage) {
        await desktop.saveSettings(value());
        initial = structuredClone($state.snapshot(form));
        initial.extraPath = paths.split('\n');
      }
      desktop.notice = '设置已保存。';
      status = '设置已保存。';
      return true;
    } catch (error) {
      saveError = errorMessage(error);
      return false;
    } finally {
      // 保存的后续导航由调用方统一执行，避免监听器与主操作重复导航。
      waitingForTask = false;
      busy = null;
    }
  }
  async function save() {
    if (!(await persist())) return;
    // 提交期间点击侧栏时，优先执行最新目的地，避免跳回旧会话。
    if (pendingLeave) discard();
    else if (!modelsVisited) onclose();
  }
  // 检测或模型读取期间的导航可排队；任务结束且无草稿时继续执行。
  $effect(() => {
    if (
      waitingForTask &&
      confirmLeave &&
      pendingLeave &&
      !busy &&
      !modelsBusy &&
      !dirty &&
      !saveError
    )
      discard();
  });
  /** 确认条主操作：保存成功后继续前往被拦下的目的地。 */
  async function saveAndLeave(): Promise<void> {
    if (!(await persist())) return;
    const action = pendingLeave ?? onclose;
    cancelLeave();
    action();
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
      class:unsaved
      aria-label="返回对话"
      title={dirty ? '有未保存的更改' : undefined}
      onclick={(event) => {
        event.currentTarget.focus({ preventScroll: true });
        close();
      }}
      ><span aria-hidden="true">←</span> 返回对话{#if dirty}<span
          class="unsaved-dot"
          aria-hidden="true"
        ></span>{/if}</button
    >
  </header>
  <div class="settings-layout">
    <nav aria-label="设置分类">
      {#each sections as item}
        {@const pending = changed[item.id as keyof typeof changed]}
        <button
          class:active={section === item.id}
          aria-current={section === item.id ? 'page' : undefined}
          title={pending ? `${item.label}有未保存的更改` : undefined}
          onclick={() => {
            section = item.id;
            if (section === 'models') modelsVisited = true;
          }}
          ><Icon name={item.icon} size={18} />{item.label}{#if pending}<span
              class="unsaved-dot"
              aria-hidden="true"
            ></span>{/if}</button
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
      <fieldset disabled={!!busy || modelsBusy} hidden={section === 'models'}>
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
              登录仍由 Pi CLI 管理。启动路径和环境配置用于下次启动 Pi。
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
              <label for="max-concurrent-tasks">跨项目并发任务数</label>
              <p id="concurrency-help">
                所有项目合计最多同时执行这些会话，超出时依提交顺序排队。等待确认的任务仍占用名额。
              </p>
              <input
                id="max-concurrent-tasks"
                type="number"
                min="1"
                max="16"
                step="1"
                bind:value={form.maxConcurrentTasks}
                aria-describedby="concurrency-help"
              />
              <label for="idle-process-limit">空闲进程缓存数量</label>
              <p id="idle-process-help">
                全局按需保留，切换会话时复用。默认 5 个，0
                表示不缓存后台进程；运行任务另计。缓存不会因空闲时间自动释放，会持续占用内存。
              </p>
              <input
                id="idle-process-limit"
                type="number"
                min="0"
                max="20"
                step="1"
                bind:value={form.idleProcessLimit}
                aria-describedby="idle-process-help"
              />
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
  <footer class="settings-footer" class:confirming={confirmLeave}>
    {#if confirmLeave}<div class="leave-confirm">
        <span class="leave-icon" aria-hidden="true">
          <Icon name="warning" size={16} />
        </span>
        <div class="leave-copy">
          <div id={leaveHeadingId} role="alert">
            <strong>{dirty ? '有未保存的更改' : '正在处理设置'}</strong>
            <span class="leave-scope">
              {changedList.map((item) => item.label).join('、')}
            </span>
          </div>
          <p>
            <span>将前往：{leaveTarget}。 </span>
            {#if busy || modelsBusy}正在处理设置，完成后可继续。
            {:else if dirty}放弃后这些修改会丢失。{/if}
          </p>
          {#if saveError}<p class="error-text" role="alert">{saveError}</p>{/if}
        </div>
        <div class="leave-actions">
          <button
            disabled={!!busy || modelsBusy}
            onclick={() => void keepEditing()}>继续编辑</button
          >
          <button
            class="destructive"
            disabled={!!busy || modelsBusy}
            onclick={discard}>放弃更改并继续</button
          >
          <button
            bind:this={leavePrimary}
            class="primary"
            disabled={!!busy || modelsBusy}
            aria-describedby={leaveHeadingId}
            onclick={() => void saveAndLeave()}
            >{busy === 'save' || modelsBusy
              ? '正在保存…'
              : leaveTarget === '返回对话'
                ? '保存并返回'
                : '保存并继续'}</button
          >
        </div>
      </div>
    {:else}<div class="save-hint" role="status">
        {#if saveError}<span class="error-text" role="alert">{saveError}</span>
        {:else if status}<span>{status}</span>
        {:else if dirty}<span class="hint-dirty"
            ><span class="unsaved-dot" aria-hidden="true"></span>有未保存的更改
            · {changedList.map((item) => item.label).join('、')}</span
          >{:else}设置保存在本机{/if}
      </div>
      <button
        class:primary={dirty}
        disabled={!!busy || modelsBusy}
        onclick={save}
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
    flex-shrink: 0;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 16px;
    padding: 18px 32px;
    border-top: 1px solid var(--border);
  }
  /* 确认条占满整行，用警示底色与主操作表明导航已被拦下。 */
  .settings-footer.confirming {
    display: block;
    padding: 14px 32px;
    background: var(--warning-soft);
    border-top-color: color-mix(in srgb, var(--warning) 35%, var(--border));
  }
  .save-hint {
    font-size: 13px;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .hint-dirty {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    color: var(--warning);
    font-weight: 500;
  }
  .settings-footer > button {
    flex-shrink: 0;
    padding: 10px 20px;
  }
  .unsaved-dot {
    display: inline-block;
    flex-shrink: 0;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--warning);
  }
  .return-button.unsaved {
    color: var(--warning);
  }
  nav button .unsaved-dot {
    margin-left: auto;
  }
  .leave-confirm {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    flex-wrap: wrap;
    font-size: 13px;
    min-width: 0;
  }
  .leave-icon {
    display: grid;
    place-items: center;
    flex-shrink: 0;
    width: 28px;
    height: 28px;
    border-radius: 8px;
    color: var(--warning);
    background: color-mix(in srgb, var(--warning) 14%, var(--bg));
  }
  .leave-copy {
    flex: 1;
    min-width: 190px;
    line-height: 1.6;
  }
  .leave-copy strong {
    font-weight: 600;
  }
  .leave-scope {
    margin-left: 8px;
    color: var(--settings-muted);
  }
  .leave-copy p {
    margin: 3px 0 0;
    font-size: 12px;
    color: var(--settings-muted);
    overflow-wrap: anywhere;
  }
  .leave-copy .error-text {
    color: var(--error);
  }
  .leave-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    margin-left: auto;
  }
  /* 放弃会丢失草稿，因此以次要外观呈现。 */
  .leave-actions .destructive {
    color: var(--error);
  }
  .leave-actions .primary {
    padding: 9px 16px;
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
    .settings-footer.confirming {
      padding: 12px 18px;
    }
    /* 窄窗口下按钮换行到文本下方，保持可点击尺寸。 */
    .leave-confirm {
      gap: 10px;
    }
    .leave-actions {
      width: 100%;
      margin-left: 0;
      padding-left: 40px;
    }
    .leave-actions button {
      flex: 1 1 auto;
      min-height: 36px;
      padding: 8px 10px;
      font-size: 12px;
    }
  }
</style>
