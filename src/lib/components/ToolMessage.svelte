<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import type { ContentPage, Message } from '../types';
  import {
    colorCode,
    languageForPath,
    toolPreview,
  } from '../tool-presentation';
  import ToolCode from './ToolCode.svelte';
  import ToolContent from './ToolContent.svelte';
  import Icon from './Icon.svelte';
  let {
    message,
    views,
    ontoggle,
    read,
  }: {
    message: Message;
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
  let expanded = $derived(views[message.id]?.output ?? false);
  let preview = $derived(toolPreview(current));
  let isDiff = $derived(
    name === 'edit' && !!tool?.diffRef && current.status !== 'error',
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
</script>

<div class="tool-step" class:tool-failed={current.status === 'error'}>
  <button
    class="tool-heading"
    aria-expanded={expanded}
    onclick={() => ontoggle(message.id, 'output')}
  >
    <span class="status-dot" class:working={current.status === 'running'}
    ></span>
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
    <span class="tool-toggle-label">{expanded ? '收起' : '展开'}</span>
    <span class:tool-chevron-open={expanded}
      ><Icon name="down" size={14} /></span
    >
  </button>
  {#if expanded}
    <div class="tool-expanded">
      {#if isDiff && tool?.diffRef}
        <ToolContent id={tool.diffRef} diff {read} />
        {#if current.text}<ToolCode text={current.text} />{/if}
      {:else if current.contentRef}
        <ToolContent id={current.contentRef} {language} {read} />
      {:else if current.text}<ToolCode text={current.text} {language} />
      {:else}<p class="tool-empty">
          {current.status === 'running' ? '等待输出…' : '无输出'}
        </p>{/if}
      {#if tool?.writeRef}
        <button
          class="text-button"
          aria-expanded={views[message.id]?.write ?? false}
          onclick={() => ontoggle(message.id, 'write')}
          >写入内容 · {views[message.id]?.write ? '收起' : '展开'}</button
        >
        {#if views[message.id]?.write}<ToolContent
            id={tool.writeRef}
            {language}
            {read}
          />{/if}
      {/if}
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
    </div>
  {:else}
    {#if preview.text}<div class="tool-preview">
        <ToolCode text={preview.text} diff={preview.diff} {language} />
      </div>{/if}
    {#if preview.hidden > 0 || current.truncated}<button
        class="text-button tool-expand-hint"
        onclick={() => ontoggle(message.id, 'output')}
        >{preview.hidden > 0 ? `还有 ${preview.hidden} 行` : '还有更多输出'} · 展开</button
      >
    {:else if !preview.text && name !== 'read'}<p class="tool-empty">
        {current.status === 'running' ? '等待输出…' : '无输出'}
      </p>{/if}
  {/if}
  {#if warning?.truncated}<p class="tool-warning">
      工具已截断输出：{warning.firstLineExceedsLimit
        ? '首行超过大小限制'
        : warning.truncatedBy === 'lines'
          ? `显示 ${warning.outputLines ?? '?'} / ${warning.totalLines ?? '?'} 行`
          : `达到 ${Math.ceil((warning.maxBytes ?? 51200) / 1024)} KiB 大小限制`}。展开仅显示工具已返回的内容。
    </p>{/if}
  {#if tool?.fullOutputPath}<p class="tool-warning">
      完整输出路径：<code>{tool.fullOutputPath}</code>
    </p>{/if}
</div>
