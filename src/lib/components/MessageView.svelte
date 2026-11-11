<!-- 消息项可被虚拟列表频繁挂载；异步高亮与正文读取必须随组件销毁取消 DOM 更新。 -->
<script lang="ts">
  import { onMount, tick } from 'svelte';
  import MessageEditView from './MessageEdit.svelte';
  import type { MessageEdit } from '../message-edit';
  import { openUrl } from '@tauri-apps/plugin-opener';
  import { markdown, highlight, safeExternal } from '../markdown';
  import ToolMessage from './ToolMessage.svelte';
  import MessageImage from './MessageImage.svelte';
  import UserText from './UserText.svelte';
  import SkillCard from './SkillCard.svelte';
  import MessageFiles from './MessageFiles.svelte';
  import { foldable } from '../draft-parts';
  import { fullText } from '../text-presentation';
  import type { ContentPage, Message, MessageTextPart } from '../types';
  import Icon from './Icon.svelte';
  /** onfull 打开分块正文，onload 只读取有界预览；不向组件暴露本地路径。 */
  let {
    message,
    edit,
    editUnavailable = '',
    editLocked = false,
    onedit,
    oncancelEdit,
    onresend,
    onfull,
    onload,
    onerror,
    toolViews,
    ontoggletool,
    read,
    onchange,
    ontext,
    selectedPart,
    onlayout = (change) => change(),
  }: {
    message: Message;
    edit?: MessageEdit | null;
    editUnavailable?: string;
    editLocked?: boolean;
    onedit?: (message: Message) => void;
    oncancelEdit?: () => void;
    onresend?: () => void;
    ontext?: (
      message: Message,
      part: MessageTextPart,
      trigger: HTMLButtonElement,
    ) => void;
    selectedPart?: string;
    onlayout?: (change: () => void, trigger?: HTMLElement) => void;
    onchange?: (message: Message, trigger: HTMLButtonElement) => void;
    onfull: (message: Message) => void;
    onload: (message: Message) => Promise<void>;
    onerror: (message: string) => void;
    toolViews: Record<string, Record<string, boolean>>;
    ontoggletool: (id: string, section: string) => void;
    read: (id: string, offset: number) => Promise<ContentPage>;
  } = $props();
  let editTrigger = $state<HTMLButtonElement>();
  function cancelEdit(): void {
    onlayout(() => oncancelEdit?.());
    void tick().then(() => editTrigger?.focus({ preventScroll: true }));
  }
  let body = $state<HTMLDivElement>();
  let copied = $state(false);
  let copyTimer: ReturnType<typeof setTimeout>;
  let copying = $state(false);
  let hasFiles = $derived(
    message.role === 'user' &&
      !!message.textParts?.some(
        (part) => part.kind === 'files' && part.files?.length,
      ),
  );
  let hasSkill = $derived(
    message.role === 'user' &&
      message.textParts?.some((part) => part.kind === 'skill' && part.skill),
  );
  let raw = $derived(!!toolViews[message.id]?.['files:raw']);
  let longUser = $derived(
    message.role === 'user' &&
      (!!message.textParts?.some((part) => part.kind === 'paste') ||
        !!message.truncated ||
        foldable(message.text)),
  );
  let html = $derived(
    hasSkill ||
      longUser ||
      message.role === 'toolResult' ||
      message.status === 'streaming'
      ? ''
      : markdown(message.text),
  );
  onMount(() => {
    if (message.role !== 'toolResult' && !message.text && message.contentRef)
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
  async function copyMessage(): Promise<void> {
    if (copying) return;
    copying = true;
    try {
      await copy(await fullText(message, read));
    } catch (cause) {
      onerror(String(cause));
    } finally {
      copying = false;
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
    <ToolMessage
      {message}
      views={toolViews}
      ontoggle={ontoggletool}
      {read}
      {onchange}
    />
  {:else if edit?.message.id === message.id}
    {#if edit.loading || (edit.error && !edit.draft.text && !edit.draft.attachments.length)}
      <div class="inline-edit-loading" role={edit.error ? 'alert' : 'status'}>
        {edit.error || '正在读取原消息…'}
        <button class="text-button" onclick={cancelEdit}>取消</button>
      </div>
    {:else}
      <MessageEditView
        {edit}
        unavailable={editUnavailable}
        onsend={() => onresend?.()}
        oncancel={cancelEdit}
      />
    {/if}
  {:else}
    {#if message.delivery}<div class="delivery-status" role="status">
        {message.delivery.mode === 'steer' ? '引导消息' : '后续消息'} · {message
          .delivery.state === 'sending'
          ? '正在提交'
          : message.delivery.mode === 'steer'
            ? '等待处理'
            : '等待当前任务完成'}
      </div>{/if}
    {#each message.images ?? [] as image, index (`${image.id}-${index}`)}
      <MessageImage {image} {read} />
    {/each}
    {#if message.thinking}<div class="thinking">
        <div class="summary-label">思考过程</div>
        <pre>{message.thinking}</pre>
      </div>{/if}
    {#if message.role === 'compactionSummary'}<div class="summary-label">
        上下文已压缩
      </div>{/if}
    {#if hasSkill}
      <div class="user-message-parts skill-message-parts">
        {#each message.textParts ?? [] as part (part.id)}
          {#if part.kind === 'skill' && part.skill}
            <SkillCard
              skill={part.skill}
              {read}
              {onlayout}
              expanded={toolViews[message.id]?.[`skill:${part.id}`] ?? false}
              ontoggle={() => ontoggletool(message.id, `skill:${part.id}`)}
            />
          {:else if part.kind === 'files' && part.files}
            <MessageFiles
              files={part.files}
              views={toolViews[message.id] ?? {}}
              toggle={(key) => ontoggletool(message.id, key)}
              {onlayout}
            />
          {:else}
            <UserText
              source={part}
              {read}
              {onlayout}
              expanded={toolViews[message.id]?.[`text:${part.id}`] ?? false}
              ontoggle={() => ontoggletool(message.id, `text:${part.id}`)}
            />
          {/if}
        {/each}
      </div>
    {:else if hasFiles && !raw}
      <div class="user-message-parts">
        {#each message.textParts ?? [] as part (part.id)}
          {#if part.kind === 'files' && part.files}
            <MessageFiles
              files={part.files}
              views={toolViews[message.id] ?? {}}
              toggle={(key) => ontoggletool(message.id, key)}
              {onlayout}
            />
          {:else if part.kind === 'paste'}
            <button
              type="button"
              class="message-text-card"
              class:selected={selectedPart === part.id}
              aria-label={`查看粘贴文本：${
                part.text
                  .trim()
                  .split(/\r\n|\r|\n/)[0]
                  ?.slice(0, 100) || '空文本'
              }，${part.chars.toLocaleString()} 字`}
              aria-expanded={selectedPart === part.id}
              onclick={(event) => ontext?.(message, part, event.currentTarget)}
              ><Icon name="copy" size={16} /><span class="message-card-content"
                ><span class="message-card-title"
                  >{Array.from(
                    part.text.trim().split(/\r\n|\r|\n/)[0] || '空文本',
                  )
                    .slice(0, 100)
                    .join('')}</span
                ><span class="message-card-meta"
                  >粘贴文本 · {part.chars.toLocaleString()} 字</span
                ></span
              ><span aria-hidden="true">›</span></button
            >
          {:else if part.text || part.truncated}
            {#if !part.truncated && !foldable(part.text) && !message.textParts?.some((p) => p.kind === 'paste')}
              <div
                class="markdown"
                onclick={click}
                onkeydown={() => {}}
                role="presentation"
              >
                {@html markdown(part.text)}
              </div>
            {:else}
              <UserText
                source={part}
                {read}
                {onlayout}
                expanded={toolViews[message.id]?.[`text:${part.id}`] ?? false}
                ontoggle={() => ontoggletool(message.id, `text:${part.id}`)}
              />
            {/if}
          {/if}
        {/each}
      </div>
      <button
        type="button"
        class="text-button"
        onclick={(event) =>
          onlayout(
            () => ontoggletool(message.id, 'files:raw'),
            event.currentTarget,
          )}>查看原文</button
      >
    {:else if hasFiles && raw}
      <UserText
        source={message}
        {read}
        {onlayout}
        expanded={true}
        ontoggle={() => {}}
      />
      <button
        type="button"
        class="text-button"
        onclick={(event) =>
          onlayout(
            () => ontoggletool(message.id, 'files:raw'),
            event.currentTarget,
          )}>返回卡片</button
      >
    {:else if longUser}
      <div class="user-message-parts">
        {#if message.textParts?.length}
          {#each message.textParts as part (part.id)}
            {#if part.kind === 'paste'}
              <button
                type="button"
                class="message-text-card"
                class:selected={selectedPart === part.id}
                aria-label={`查看粘贴文本：${
                  part.text
                    .trim()
                    .split(/\r\n|\r|\n/)[0]
                    ?.slice(0, 100) || '空文本'
                }，${part.chars.toLocaleString()} 字`}
                aria-expanded={selectedPart === part.id}
                onclick={(event) =>
                  ontext?.(message, part, event.currentTarget)}
              >
                <Icon name="copy" size={16} />
                <span class="message-card-content"
                  ><span class="message-card-title"
                    >{Array.from(
                      part.text.trim().split(/\r\n|\r|\n/)[0] || '空文本',
                    )
                      .slice(0, 100)
                      .join('')}</span
                  ><span class="message-card-meta"
                    >粘贴文本 · {part.chars.toLocaleString()} 字</span
                  ></span
                >
                <span aria-hidden="true">›</span>
              </button>
            {:else if part.text || part.truncated}
              <UserText
                source={part}
                {read}
                {onlayout}
                expanded={toolViews[message.id]?.[`text:${part.id}`] ?? false}
                ontoggle={() => ontoggletool(message.id, `text:${part.id}`)}
              />
            {/if}
          {/each}
        {:else}
          <UserText
            source={message}
            {read}
            {onlayout}
            expanded={toolViews[message.id]?.text ?? false}
            ontoggle={() => ontoggletool(message.id, 'text')}
          />
        {/if}
      </div>
    {:else if message.status === 'streaming'}<div class="streaming-text">
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
    <!-- 工具调用旁可能有仅含空白的助手消息，不为其显示无内容可复制的操作栏。 -->
    {#if message.status !== 'streaming' && (message.text.trim() || message.images?.length)}<div
        class="message-actions"
      >
        <button
          class="icon-button"
          aria-label={copying ? '正在读取并复制消息' : '复制消息'}
          disabled={copying}
          onclick={() => void copyMessage()}
          ><Icon name={copied ? 'check' : 'copy'} size={15} /></button
        >{#if message.role === 'user' && !message.delivery && !message.id.startsWith('accepted-') && onedit}<button
            bind:this={editTrigger}
            type="button"
            class="icon-button"
            title="编辑并重发"
            aria-label="编辑并重发"
            disabled={editLocked}
            onclick={() => onlayout(() => onedit?.(message))}
            ><Icon name="edit" size={15} /></button
          >{/if}{#if !hasSkill && !longUser && message.contentRef && message.truncated}<button
            class="text-button"
            onclick={() => onfull(message)}>查看完整正文</button
          >{/if}
      </div>{/if}
  {/if}
</article>

<style>
  /* flex 子项需要显式允许收缩，否则长技能名会在窄窗口撑出正文边界。 */
  .skill-message-parts {
    min-width: 0;
    max-width: 100%;
    width: 480px;
  }
</style>
