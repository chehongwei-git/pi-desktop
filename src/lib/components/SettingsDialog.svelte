<!-- 设置只编辑应用启动配置；Pi 登录、模型密钥和技能安装继续交给 Pi CLI。 -->
<script lang="ts">
  import { open } from '@tauri-apps/plugin-dialog';
  import Modal from './Modal.svelte';
  import type { Desktop } from '../state/desktop.svelte';
  import { errorMessage } from '../client';
  /** 保存成功后关闭；未保存草稿只存在弹层生命周期内。 */
  let { desktop, onclose }: { desktop: Desktop; onclose: () => void } =
    $props();
  let form = $state(initialSettings());
  let paths = $state(form.extraPath.join('\n'));
  let diagnostic = $state('');
  let busy = $state(false);
  /** 弹层打开时拍摄一次快照，不让后续外部设置覆盖正在编辑的表单。 */
  function initialSettings() {
    return structuredClone($state.snapshot(desktop.settings));
  }
  /** 原生选择器取消不改值；未知 cmd 由宿主给出 Node+CLI 配置说明。 */
  async function browse(
    field: 'piPath' | 'runtimePath' | 'sessionDir',
  ): Promise<void> {
    try {
      const result = await open({
        directory: field === 'sessionDir',
        multiple: false,
      });
      if (typeof result === 'string') form[field] = result;
    } catch (error) {
      diagnostic = errorMessage(error);
    }
  }
  /** 表单转换只去除空行，不隐式改变目录大小写或展开 shell 变量。 */
  function value() {
    return {
      ...$state.snapshot(form),
      zoom: desktop.settings.zoom,
      extraPath: paths
        .split('\n')
        .map((x) => x.trim())
        .filter(Boolean),
    };
  }
  /** 版本探测不启动 Agent，输出只包括安全路径与版本信息。 */
  async function detect(): Promise<void> {
    busy = true;
    try {
      const result = await desktop.detect(value());
      diagnostic = `Pi ${result.version}\n${result.spec.executable}\n${result.spec.args.join('\n')}\n${result.verified ? '已验证基线' : '未经本版验证，将探测 RPC 能力'}`;
    } catch (error) {
      diagnostic = errorMessage(error);
    } finally {
      busy = false;
    }
  }
  /** 原子保存由宿主负责；错误时弹层保持打开以便修复。 */
  async function save(): Promise<void> {
    busy = true;
    try {
      await desktop.saveSettings(value());
      onclose();
      desktop.notice = '设置已保存，启动配置在下次连接时生效。';
    } catch (error) {
      diagnostic = errorMessage(error);
    } finally {
      busy = false;
    }
  }
</script>

<Modal title="设置" {onclose} wide>
  <div class="settings-form">
    <p class="muted">
      连接本机已有 Pi。模型登录与 API Key 请在 Pi CLI 中配置。
    </p>
    <label
      >Pi 入口路径 <span class="muted">留空自动发现</span>
      <div class="input-row">
        <input
          bind:value={form.piPath}
          placeholder="pi.exe / pi.cmd / cli.js / pi"
        /><button onclick={() => browse('piPath')}>浏览</button>
      </div></label
    >
    <label
      >Node / Bun 运行时 <span class="muted">脚本入口可选</span>
      <div class="input-row">
        <input
          bind:value={form.runtimePath}
          placeholder="自动查找 Node"
        /><button onclick={() => browse('runtimePath')}>浏览</button>
      </div></label
    >
    <label
      >额外 PATH 目录 <span class="muted">每行一个，仅对子进程生效</span
      ><textarea
        bind:value={paths}
        rows="3"
        placeholder="终端与桌面环境 PATH 不同时可在此补充"></textarea></label
    >
    <label
      >会话目录 <span class="muted">留空使用 Pi 默认目录</span>
      <div class="input-row">
        <input bind:value={form.sessionDir} /><button
          onclick={() => browse('sessionDir')}>浏览</button
        >
      </div></label
    >
    <label
      >外观<select bind:value={form.theme}
        ><option value="system">跟随系统</option><option value="light"
          >浅色</option
        ><option value="dark">深色</option></select
      ></label
    >
    <div class="settings-note">
      Pi 的工具可访问所选项目与本机资源。桌面界面的 IPC 限制不构成 Agent
      工具沙箱。TUI 自定义组件不会在桌面端仿真。
    </div>
    {#if diagnostic}<pre
        class="diagnostic"
        aria-live="polite">{diagnostic}</pre>{/if}
    <footer class="modal-actions">
      <button disabled={busy} onclick={detect}>检测 Pi</button><button
        class="primary"
        disabled={busy}
        onclick={save}>保存设置</button
      >
    </footer>
  </div>
</Modal>
