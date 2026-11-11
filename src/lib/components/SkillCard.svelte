<!-- 技能仅改变展示；说明按需读取，包装原文仍由消息复制和编辑流程保留。 -->
<script lang="ts">
  import { tick } from 'svelte';
  import Icon from './Icon.svelte';
  import TextReader from './TextReader.svelte';
  import type { ContentPage, MessageTextPart } from '../types';
  let {
    skill,
    expanded,
    ontoggle,
    onlayout,
    read,
  }: {
    skill: NonNullable<MessageTextPart['skill']>;
    expanded: boolean;
    ontoggle: () => void;
    onlayout: (change: () => void, trigger?: HTMLElement) => void;
    read: (id: string, offset: number) => Promise<ContentPage>;
  } = $props();
  const id = $props.id();
  let root = $state<HTMLElement>();
  let trigger = $state<HTMLButtonElement>();
  function close() {
    onlayout(ontoggle, trigger);
    void tick().then(() => trigger?.focus({ preventScroll: true }));
  }
</script>

<svelte:window
  onkeydown={(event) => {
    if (
      expanded &&
      event.key === 'Escape' &&
      root?.contains(document.activeElement)
    ) {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  }}
/>
<section class="skill-card" aria-label={`技能：${skill.name}`} bind:this={root}>
  <button
    type="button"
    class="skill-trigger"
    bind:this={trigger}
    aria-expanded={expanded}
    aria-controls={id}
    onclick={() => onlayout(ontoggle)}
  >
    <Icon name="file" size={17} />
    <span class="skill-label">技能</span>
    <strong title={skill.name}>{skill.name}</strong>
    <span class="skill-action">{expanded ? '收起说明' : '查看说明'}</span>
    <span class:expanded aria-hidden="true"><Icon name="down" size={14} /></span
    >
  </button>
  {#if expanded}
    <div {id} class="skill-detail" role="region" aria-label="技能说明">
      <div class="skill-location">{skill.location}</div>
      <!-- svelte-ignore a11y_no_noninteractive_tabindex (长说明独立滚动，需要键盘聚焦。) -->
      <div class="skill-body" tabindex="0">
        <TextReader source={skill} {read} />
      </div>
      <button type="button" class="text-button" onclick={close}>收起说明</button
      >
    </div>
  {/if}
</section>

<style>
  .skill-card {
    /* 父级保留用户原文换行，卡片自身恢复普通排版，避免模板空白撑高。 */
    white-space: normal;
    min-width: 0;
    margin-bottom: 10px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--surface);
    overflow: hidden;
  }
  .skill-trigger {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    min-height: 44px;
    padding: 10px 12px;
    border: 0;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
    text-align: left;
    font-size: 13px;
  }
  .skill-trigger:hover {
    background: var(--bg);
  }
  .skill-trigger:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -3px;
  }
  strong {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text);
    font-weight: 600;
  }
  .skill-label,
  .skill-action {
    flex-shrink: 0;
    font-size: 12px;
  }
  .expanded {
    transform: rotate(180deg);
  }
  .skill-detail {
    border-top: 1px solid var(--border);
    padding: 12px;
  }
  .skill-location {
    color: var(--muted);
    font: 12px/1.5 var(--font-mono);
    overflow-wrap: anywhere;
    margin-bottom: 10px;
  }
  .skill-body {
    max-height: min(380px, 50vh);
    overflow: auto;
    overscroll-behavior: contain;
    text-align: left;
    font-size: 13px;
    line-height: 1.65;
  }
  .skill-body :global(.user-plain-text) {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .skill-detail > button {
    margin-top: 8px;
  }
</style>
