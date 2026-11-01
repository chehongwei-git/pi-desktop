<script lang="ts">
  import { onDestroy, tick, untrack } from 'svelte';
  import type { ContentPage, Message } from '../types';
  import { colorCode, languageForPath } from '../tool-presentation';
  import ToolCode from './ToolCode.svelte';
  import ToolContent from './ToolContent.svelte';
  import Icon from './Icon.svelte';
  let {
    message,
    views,
    ontoggle,
    read,
    onchange,
  }: {
    message: Message;
    onchange?: (message: Message, trigger: HTMLButtonElement) => void;
    views: Record<string, Record<string, boolean>>;
    ontoggle: (id: string, section: string) => void;
    read: (id: string, offset: number) => Promise<ContentPage>;
  } = $props();
  let shown = $state<Message>();
  let latest: Message;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let last = 0;
  function publish(): void {
    shown = latest;
    last = performance.now();
    timer = undefined;
  }
  $effect(() => {
    const value = $state.snapshot(message);
    untrack(() => {
      latest = value;
      if (
        value.status !== 'running' ||
        performance.now() - last >= 100 ||
        !shown
      ) {
        clearTimeout(timer);
        publish();
      } else if (!timer)
        timer = setTimeout(publish, 100 - (performance.now() - last));
    });
  });
  onDestroy(() => clearTimeout(timer));
  let current = $derived(shown ?? message);
  let tool = $derived(current.tool);
  let name = $derived(tool?.name ?? current.name ?? '工具');
  let codeEdit = $derived(name === 'edit' || name === 'write');
  let expanded = $derived(!codeEdit && (views[message.id]?.output ?? false));

  let isDiff = $derived(
    !!(tool?.diffRef || tool?.writeRef) &&
      current.status !== 'error' &&
      current.status !== 'running',
  );
  let language = $derived(
    ['read', 'write'].includes(name) && current.status !== 'error'
      ? languageForPath(tool?.path ?? '')
      : undefined,
  );
  let commandHtml = $state('');
  $effect(() => {
    const command = tool?.command;
    let alive = true;
    commandHtml = '';
    if (command)
      void colorCode(command, name === 'powershell' ? 'powershell' : 'bash')
        .then((html) => {
          if (alive) commandHtml = html;
        })
        .catch(() => {});
    return () => {
      alive = false;
    };
  });
  let warning = $derived(tool?.truncation);
  let heading: HTMLButtonElement;
  /** 末尾入口卸载后回到同一工具，避免焦点丢失或停留在收起前的深处。 */
  async function collapse(): Promise<void> {
    ontoggle(message.id, 'output');
    await tick();
    heading?.focus({ preventScroll: true });
    heading?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  }
</script>

<div class="tool-step" class:tool-failed={current.status === 'error'}>
  <button
    class="tool-heading"
    bind:this={heading}
    aria-expanded={codeEdit ? undefined : expanded}
    disabled={codeEdit}
    onclick={() => {
      if (expanded) void collapse();
      else ontoggle(message.id, 'output');
    }}
  >
    <!-- 工具保留静态状态点；唯一活动动画放在对话末尾。 -->
    <span class="status-dot" aria-hidden="true"></span>
    <strong class="tool-name">{name}</strong>
    {#if tool?.command}<span class="tool-command" title={tool.command}
        >{#if commandHtml}{@html commandHtml}{:else}{tool.command}{/if}</span
      >
    {:else if tool?.path}<span class="tool-path" title={tool.path}
        >{tool.path}{#if tool.offset != null}<span class="tool-range"
            >:{tool.offset}{tool.limit != null
              ? `–${tool.offset + tool.limit - 1}`
              : ''}</span
          >{/if}</span
      >{/if}
    <span class="tool-state"
      >{current.status === 'running'
        ? '执行中'
        : current.status === 'error'
          ? '执行失败'
          : '已完成'}</span
    >
    {#if !codeEdit}<span class="tool-toggle-label"
        >{expanded ? '收起详情' : '查看详情'}</span
      >
      <span class:tool-chevron-open={expanded}
        ><Icon name="down" size={14} /></span
      >{/if}
  </button>
  {#if codeEdit && current.status === 'error'}<p
      class="tool-load-error"
      role="alert"
    >
      {current.text || '编辑失败，未取得错误详情'}
    </p>{/if}
  {#if isDiff}
    <div class="tool-change-summary">
      {#if tool?.addedLines != null && tool?.removedLines != null}
        <span class="change-added" aria-label={`新增 ${tool.addedLines} 行`}
          >+{tool.addedLines}</span
        >
        <span class="change-removed" aria-label={`删除 ${tool.removedLines} 行`}
          >−{tool.removedLines}</span
        >
      {/if}
      <button
        class="text-button"
        onclick={(event) => onchange?.(current, event.currentTarget)}
        >查看变更</button
      >
    </div>
  {/if}
  {#if expanded}
    <div class="tool-expanded">
      {#if current.contentRef}
        <ToolContent id={current.contentRef} {language} {read} />
      {:else if current.text}<ToolCode text={current.text} {language} />
      {:else}<p class="tool-empty">
          {current.status === 'running' ? '等待输出…' : '无输出'}
        </p>{/if}
      {#if tool?.argsRef}
        <button
          class="text-button"
          aria-expanded={views[message.id]?.args ?? false}
          onclick={() => ontoggle(message.id, 'args')}
          >调用参数 · {views[message.id]?.args ? '收起' : '展开'}</button
        >
        {#if views[message.id]?.args}<ToolContent
            id={tool.argsRef}
            language="json"
            {read}
          />{/if}
      {/if}
      <div class="tool-footer">
        <button
          class="text-button tool-collapse"
          onclick={() => void collapse()}
          ><span class="tool-chevron-open"><Icon name="down" size={14} /></span
          >收起输出</button
        >
      </div>
    </div>
  {/if}
  {#if expanded && warning?.truncated}<p class="tool-warning">
      工具已截断输出：{warning.firstLineExceedsLimit
        ? '首行超过大小限制'
        : warning.truncatedBy === 'lines'
          ? `显示 ${warning.outputLines ?? '?'} / ${warning.totalLines ?? '?'} 行`
          : `达到 ${Math.ceil((warning.maxBytes ?? 51200) / 1024)} KiB 大小限制`}。展开仅显示工具已返回的内容。
    </p>{/if}
  {#if expanded && tool?.fullOutputPath}<p class="tool-warning">
      完整输出路径：<code>{tool.fullOutputPath}</code>
    </p>{/if}
</div>
