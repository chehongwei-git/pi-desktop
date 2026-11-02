<!-- Plan 正文存于调用参数；独立于工具详情读取，避免用户为了看最终方案展开处理过程。 -->
<script lang="ts">
  import { tick } from 'svelte';
  import MessageView from './MessageView.svelte';
  import ToolMessage from './ToolMessage.svelte';
  import type { ContentPage, Message } from '../types';

  let {
    message,
    read,
    onerror,
    toolViews,
    ontoggletool,
  }: {
    message: Message;
    read: (id: string, offset: number) => Promise<ContentPage>;
    onerror: (message: string) => void;
    toolViews: Record<string, Record<string, boolean>>;
    ontoggletool: (id: string, section: string) => void;
  } = $props();
  let plan = $state('');
  let error = $state('');
  let loading = $state(false);
  let retry = $state(0);
  let ref = $derived(message.tool?.argsRef);
  let body = $derived<Message>({
    ...message,
    role: 'assistant',
    text: plan,
    thinking: '',
    contentRef: null,
    truncated: false,
    images: [],
    status: 'done',
    tool: null,
  });

  // 引用变化、会话切换或卸载后丢弃迟到结果；串行分页避免截断 JSON 导致正文丢失。
  $effect(() => {
    const id = ref;
    retry;
    let alive = true;
    plan = '';
    error = '';
    loading = !!id;
    if (!id) error = '未找到计划正文，可展开工具详情查看原始结果。';
    else
      void (async () => {
        try {
          let text = '';
          let offset = 0;
          while (alive) {
            const page = await read(id, offset);
            if (!alive) return;
            text += page.text;
            if (page.done) break;
            if (page.next <= offset) throw new Error('计划读取未前进');
            offset = page.next;
            await tick();
          }
          if (!alive) return;
          const args = JSON.parse(text);
          if (typeof args?.plan !== 'string' || !args.plan.trim())
            throw new Error('未找到有效的计划正文');
          plan = args.plan;
        } catch (cause) {
          if (alive) error = `无法读取计划：${String(cause)}`;
        } finally {
          if (alive) loading = false;
        }
      })();
    return () => {
      alive = false;
    };
  });
</script>

<section aria-label="最终计划">
  <div class="summary-label">
    {message.status === 'error'
      ? '计划提交失败'
      : message.status === 'running'
        ? '正在提交计划'
        : '最终计划'}
  </div>
  {#if loading}<p class="tool-load-status" role="status">正在读取计划…</p>{/if}
  {#if error}
    <p class="tool-load-error" role="alert">{error}</p>
    {#if ref}<button class="text-button" onclick={() => retry++}
        >重试读取计划</button
      >{/if}
  {/if}
  {#if plan}
    <MessageView
      message={body}
      {read}
      {onerror}
      {toolViews}
      {ontoggletool}
      onfull={() => {}}
      onload={async () => {}}
    />
  {/if}
  <!-- 保留原始执行状态和错误，不把参数中的方案误报为已成功提交。 -->
  <ToolMessage {message} {read} views={toolViews} ontoggle={ontoggletool} />
</section>
