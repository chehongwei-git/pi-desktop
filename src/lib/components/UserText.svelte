<!-- 长用户消息采用纯文本预览；收起不隐藏卡片，也不改变模型收到的正文。 -->
<script lang="ts">
  import { tick } from 'svelte';
  import { foldable } from '../draft-parts';
  import { textPreview } from '../text-presentation';
  import TextReader from './TextReader.svelte';
  import type { ContentPage, MessageTextPart } from '../types';
  let {
    source,
    expanded = false,
    ontoggle,
    read,
    onlayout,
  }: {
    source: Pick<MessageTextPart, 'text' | 'contentRef'> & {
      truncated?: boolean;
    };
    expanded?: boolean;
    ontoggle: () => void;
    read: (id: string, offset: number) => Promise<ContentPage>;
    onlayout: (change: () => void, trigger?: HTMLElement) => void;
  } = $props();
  const id = $props.id();
  let trigger = $state<HTMLButtonElement>()!;
  let long = $derived(source.truncated || foldable(source.text));
  function toggle(bottom = false): void {
    onlayout(() => ontoggle(), bottom ? trigger : undefined);
    if (bottom) void tick().then(() => trigger?.focus({ preventScroll: true }));
  }
</script>

<div class="user-text-part">
  {#if long}
    {#if expanded}<button
        class="text-expand"
        bind:this={trigger}
        aria-expanded="true"
        aria-controls={id}
        onclick={() => toggle()}>收起</button
      >{/if}
    <div {id}>
      {#if expanded}
        <TextReader {source} {read} />
      {:else}<div class="user-plain-text text-preview">
          {textPreview(source.text)}
        </div>{/if}
    </div>
    {#if expanded}<button class="text-expand" onclick={() => toggle(true)}
        >收起</button
      >
    {:else}<button
        class="text-expand"
        bind:this={trigger}
        aria-expanded="false"
        aria-controls={id}
        onclick={() => toggle()}
        >展开更多 <span aria-hidden="true">⌄</span></button
      >{/if}
  {:else}<span class="user-plain-text">{source.text}</span>{/if}
</div>
