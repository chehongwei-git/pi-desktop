<!-- 消息项可被虚拟列表频繁挂载；异步高亮与正文读取必须随组件销毁取消 DOM 更新。 -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { openUrl } from '@tauri-apps/plugin-opener';
  import { markdown, highlight, safeExternal } from '../markdown';
  import ToolMessage from './ToolMessage.svelte';
  import type { ContentPage, Message } from '../types';
  import Icon from './Icon.svelte';
  /** onfull 打开分块正文，onload 只读取有界预览；不向组件暴露本地路径。 */
  let {
    message,
    onfull,
    onload,
    onerror,
    toolViews,
    ontoggletool,
    read,
  }: {
    message: Message;
    onfull: (message: Message) => void;
    onload: (message: Message) => Promise<void>;
    onerror: (message: string) => void;
    toolViews: Record<string, Record<string, boolean>>;
    ontoggletool: (id: string, section: string) => void;
    read: (id: string, offset: number) => Promise<ContentPage>;
  } = $props();
  let body = $state<HTMLDivElement>();
  let copied = $state(false);
  let copyTimer: ReturnType<typeof setTimeout>;
  let html = $derived(
    message.role === 'toolResult' || message.status === 'streaming'
      ? ''
      : markdown(message.text),
  );
  onMount(() => {
    if (!message.text && message.contentRef)
      void onload(message).catch((error) => onerror(String(error)));
    return () => clearTimeout(copyTimer);
  });
  $effect(() => {
    html;
    let alive = true;
    if (body && message.status !== 'streaming')
      void highlight(body, () => alive).catch(() => {});
    return () => {
      alive = false;
    };
  });
  /** Clipboard 失败也要反馈；定时器由卸载清理。 */
  async function copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => {
        copied = false;
      }, 1500);
    } catch {
      onerror('无法访问剪贴板');
    }
  }
  /** Markdown 链接通过受限 opener；代码块点击复制按钮由事件代理统一处理。 */
  function click(event: MouseEvent): void {
    const target = event.target as HTMLElement;
    const anchor = target.closest('a');
    if (anchor) {
      event.preventDefault();
      const href = anchor.getAttribute('href') ?? '';
      if (safeExternal(href))
        void openUrl(href).catch(() => onerror('无法打开链接'));
      else onerror('仅支持 http/https 外部链接');
    }
  }
  /** 对每个代码块添加原生按钮，避免为大段 Markdown 创建组件树。 */
  $effect(() => {
    html;
    if (!body) return;
    for (const pre of body.querySelectorAll('pre')) {
      if (pre.querySelector('button')) continue;
      const button = document.createElement('button');
      button.textContent = '复制';
      button.className = 'code-copy';
      button.setAttribute('aria-label', '复制代码');
      button.onclick = () => {
        void copy(pre.querySelector('code')?.textContent ?? '');
      };
      pre.append(button);
    }
  });
</script>

<article
  class="message"
  class:user={message.role === 'user'}
  class:tool={message.role === 'toolResult'}
  class:summary={message.role === 'compactionSummary'}
>
  {#if message.role === 'toolResult'}
    <ToolMessage {message} views={toolViews} ontoggle={ontoggletool} {read} />
  {:else}
    {#if message.delivery}<div class="delivery-status" role="status">
        {message.delivery.mode === 'steer' ? '引导消息' : '后续消息'} · {message
          .delivery.state === 'sending'
          ? '正在提交'
          : message.delivery.mode === 'steer'
            ? '等待处理'
            : '等待当前任务完成'}
      </div>{/if}
    {#if message.thinking}<details class="thinking">
        <summary>思考过程</summary>
        <pre>{message.thinking}</pre>
      </details>{/if}
    {#if message.role === 'compactionSummary'}<div class="summary-label">
        上下文已压缩
      </div>{/if}
    {#if message.status === 'streaming'}<div class="streaming-text">
        {message.text}<span class="cursor"></span>
      </div>
    {:else}<div
        class="markdown"
        bind:this={body}
        onclick={click}
        onkeydown={() => {}}
        role="presentation"
      >
        {@html html}
      </div>{/if}
    {#if message.status === 'error'}<small class="error-text"
        >回答未完成，请检查连接或模型配置。</small
      >{/if}
    {#if message.status !== 'streaming' && message.text}<div
        class="message-actions"
      >
        <button
          class="icon-button"
          aria-label="复制消息"
          onclick={() => copy(message.text)}
          ><Icon name={copied ? 'check' : 'copy'} size={15} /></button
        >{#if message.contentRef && message.truncated}<button
            class="text-button"
            onclick={() => onfull(message)}>查看完整正文</button
          >{/if}
      </div>{/if}
  {/if}
</article>
