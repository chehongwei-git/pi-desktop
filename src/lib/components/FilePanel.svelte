<!-- 磁盘当前内容与历史差异分离；所有副作用只来自用户点击，不执行活跃文档。 -->
<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { errorMessage } from '../client';
  import type { FilePreview, FileTarget } from '../file-links';
  import { markdown, highlight } from '../markdown';
  let {
    target,
    project,
    onclose,
  }: { target: FileTarget; project: string; onclose: () => void } = $props();
  let preview = $state<FilePreview>();
  let loading = $state(true);
  let error = $state('');
  let feedback = $state('');
  let approved = $state(false);
  let revision = $state(0);
  let opening = $state(false);
  let source = $state(false);
  // 有行号的引用优先显示源码；用户随后仍可切回排版。
  $effect(() => {
    source = !!target.line;
  });
  let close: HTMLButtonElement;
  let content = $state<HTMLDivElement>();
  let isMarkdown = $derived(
    /\.md(?:own|arkdown)?$/i.test(preview?.path ?? target.path),
  );
  onMount(() => close.focus({ preventScroll: true }));
  // 切换或刷新后忽略旧结果；不让迟到响应覆盖新的文件和错误状态。
  $effect(() => {
    const path = target.path;
    const root = project;
    const allow = approved;
    revision;
    let alive = true;
    loading = true;
    preview = undefined;
    error = '';
    void invoke<FilePreview>('preview_file', {
      project: root,
      path,
      approved: allow,
    })
      .then((value) => {
        if (alive) preview = value;
      })
      .catch((cause) => {
        if (alive) error = errorMessage(cause);
      })
      .finally(() => {
        if (alive) loading = false;
      });
    return () => {
      alive = false;
    };
  });
  $effect(() => {
    preview;
    source;
    let alive = true;
    void tick().then(() => {
      if (!alive || !content) return;
      if (target.line) {
        const line = content.querySelector<HTMLElement>(
          `[data-line="${target.line}"]`,
        );
        // 只滚动预览内部，避免 scrollIntoView 连带移动对话阅读锚点。
        if (line)
          content.scrollTop +=
            line.getBoundingClientRect().top -
            content.getBoundingClientRect().top -
            content.clientHeight / 2;
      }
      void highlight(content, () => alive).catch(() => {});
    });
    return () => {
      alive = false;
    };
  });
  async function systemOpen() {
    if (opening || !preview?.canOpen) return;
    opening = true;
    error = '';
    try {
      await invoke('open_message_file', {
        project,
        path: target.path,
        approved,
      });
    } catch (cause) {
      error = errorMessage(cause);
    } finally {
      opening = false;
    }
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(preview?.path ?? target.path);
      feedback = '路径已复制';
    } catch {
      error = '无法复制路径，请检查剪贴板权限';
    }
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions (仅处理面板内部冒泡的 Escape。) -->
<aside
  class="change-panel file-preview-panel"
  aria-label="文件预览"
  onkeydown={(event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onclose();
    }
  }}
>
  <header class="change-panel-header file-header">
    <div class="file-title">
      <strong>{target.path.split(/[\\/]/).pop()}</strong><span
        title={preview?.path ?? target.path}
        >{preview?.path ?? target.path}</span
      >
    </div>
    <div class="file-actions">
      <button class="text-button" onclick={() => void copy()}>复制路径</button>
      <button class="text-button" disabled={loading} onclick={() => revision++}
        >刷新</button
      >
      <button class="text-button" bind:this={close} onclick={onclose}
        >关闭预览</button
      >
    </div>
  </header>
  <div class="file-meta">
    磁盘当前内容 · 非历史快照{#if preview && preview.kind !== 'approval'}
      · {preview.size.toLocaleString()} 字节{/if}
  </div>
  {#if feedback}<p role="status" class="file-notice">{feedback}</p>{/if}
  {#if error}<p role="alert" class="file-notice error-text">
      {error}
      <button class="text-button" disabled={loading} onclick={() => revision++}
        >重试读取</button
      >
    </p>{/if}
  {#if loading}<p role="status" class="file-notice">正在读取文件…</p>
  {:else if preview?.kind === 'approval'}
    <div class="file-notice">
      <p>
        此文件位于会话项目之外（包括符号链接目标）。确认后仅访问本次文件，不上传内容。
      </p>
      <button class="text-button" onclick={() => (approved = true)}
        >允许本次访问</button
      ><button class="text-button" onclick={onclose}>取消</button>
    </div>
  {:else if preview}
    <div class="file-toolbar">
      {#if preview.canOpen}<button
          class="text-button"
          disabled={opening}
          onclick={() => void systemOpen()}
          >{opening
            ? '正在打开…'
            : preview.kind === 'directory'
              ? '在文件管理器中打开'
              : '使用系统默认应用打开'}</button
        >{/if}
      {#if isMarkdown && preview.kind === 'text'}<button
          class="text-button"
          aria-pressed={source}
          onclick={() => (source = !source)}
          >{source ? '查看排版' : '查看源码'}</button
        >{/if}
    </div>
    {#if preview.truncated && preview.kind === 'text'}<p
        class="file-notice"
        role="status"
      >
        仅预览前 256 KiB；查看完整内容请使用系统应用。{target.line
          ? `目标行：${target.line}`
          : ''}
      </p>{/if}
    <div class="change-panel-body file-body" bind:this={content}>
      {#if preview.kind === 'text'}
        {#if isMarkdown && !source}
          <!-- 预览内链接不导航或再次授权；仍保留清洗与远程图片阻止。 -->
          <div
            class="markdown"
            role="presentation"
            onclick={(event) => {
              if ((event.target as HTMLElement).closest('a')) {
                event.preventDefault();
                feedback = '预览内链接不自动打开，请复制路径或返回对话打开';
              }
            }}
            onkeydown={() => {}}
          >
            {@html markdown(preview.text ?? '')}
          </div>
        {:else}
          <pre
            class="file-source">{#each (preview.text ?? '').split('\n') as line, index}<span
                class="source-line"
                class:current={index + 1 === target.line}
                data-line={index + 1}
                ><span class="line-number" aria-hidden="true">{index + 1}</span
                ><code>{line || '\n'}</code></span
              >{/each}</pre>
        {/if}
      {:else if preview.kind === 'image'}
        <img
          class="file-image"
          src={preview.image}
          alt={target.path.split(/[\\/]/).pop()}
          onerror={() => (error = '图片无法解码，请尝试系统应用打开')}
        />
      {:else}<p class="file-notice">
          {preview.kind === 'directory'
            ? '目录不递归读取。'
            : '此格式暂不提供内嵌预览（或编码、大小不支持）。'}{!preview.canOpen
            ? '为避免运行程序，此类型仅提供路径复制。'
            : '请使用系统默认应用打开。'}
        </p>{/if}
    </div>
  {/if}
</aside>

<style>
  /* 容器查询依据侧栏实际宽度调整留白，不依赖应用窗口尺寸。 */
  .file-preview-panel {
    container-type: inline-size;
    --file-gutter: 24px;
  }
  .file-header {
    flex-wrap: wrap;
    gap: 16px;
    padding: 20px var(--file-gutter) 16px;
    border-bottom: 0;
    align-items: flex-start;
  }
  .file-title {
    min-width: 0;
    flex: 1 1 180px;
    display: grid;
    gap: 6px;
  }
  .file-title strong {
    overflow-wrap: anywhere;
    font-size: 15px;
    line-height: 1.5;
    font-weight: 600;
  }
  .file-title span {
    font-size: 12px;
    color: var(--muted);
    overflow-wrap: anywhere;
    line-height: 1.6;
  }
  .file-actions,
  .file-toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
  }
  .file-actions button,
  .file-toolbar button {
    min-height: 32px;
    padding: 6px 10px;
    border-radius: 8px;
  }
  .file-actions {
    margin-inline: -10px;
  }
  .file-meta {
    padding: 0 var(--file-gutter) 14px;
    color: var(--muted);
    font-size: 12px;
    line-height: 1.6;
    border-bottom: 1px solid var(--border);
  }
  .file-toolbar {
    padding: 12px calc(var(--file-gutter) - 10px) 0;
  }
  .file-notice {
    margin: 16px var(--file-gutter) 0;
    padding: 14px 16px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--surface);
    font-size: 13px;
    line-height: 1.75;
    overflow-wrap: anywhere;
  }
  .file-notice p {
    margin: 0 0 12px;
  }
  .file-notice button {
    margin-top: 6px;
    min-height: 32px;
  }
  .file-body > .file-notice {
    margin: 0;
  }
  .file-body {
    min-height: 0;
    overflow: auto;
    overscroll-behavior: contain;
    padding: 20px var(--file-gutter) 32px;
    scrollbar-gutter: stable;
  }
  .file-body > .markdown {
    max-width: 760px;
    margin-inline: auto;
    line-height: 1.8;
    overflow-wrap: anywhere;
  }
  .file-body > .markdown :global(> :first-child) {
    margin-top: 0;
  }
  .file-body > .markdown :global(pre) {
    max-width: 100%;
    overflow: auto;
  }
  .file-body > .markdown :global(table) {
    display: block;
    max-width: 100%;
    overflow: auto;
  }
  .file-source {
    margin: 0;
    padding-block: 12px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--surface);
    font: 13px/1.8 var(--font-mono);
    white-space: pre-wrap;
    overflow: hidden;
  }
  .source-line {
    display: flex;
    min-height: 1.8em;
    padding-inline: 8px 16px;
    border-inline-start: 3px solid transparent;
  }
  .source-line.current {
    background: color-mix(in srgb, var(--accent) 9%, var(--surface));
    border-inline-start-color: var(--accent);
  }
  .line-number {
    flex: 0 0 3.5em;
    text-align: right;
    padding-right: 12px;
    color: var(--muted);
    user-select: none;
  }
  .source-line code {
    min-width: 0;
    overflow-wrap: anywhere;
    flex: 1;
  }
  .file-image {
    display: block;
    max-width: 100%;
    height: auto;
    margin: 0 auto;
    padding: 16px;
    box-sizing: border-box;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--surface);
  }
  @container (max-width: 520px) {
    .file-header,
    .file-meta,
    .file-toolbar,
    .file-notice,
    .file-body {
      --file-gutter: 16px;
    }
    .file-header {
      gap: 10px;
      padding-top: 16px;
    }
    .file-actions {
      width: 100%;
    }
    .file-source {
      font-size: 12px;
    }
    .source-line {
      padding-inline-end: 10px;
    }
    .line-number {
      flex-basis: 3em;
    }
  }
</style>
