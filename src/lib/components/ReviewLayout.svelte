<!-- 通高审阅区域与输入区是兄弟列；输入区增高不会改变详情边界。 -->
<script lang="ts">
  import { setContext, onMount } from 'svelte';
  import type { Snippet } from 'svelte';
  import { reviewKey, ReviewLayoutState } from '../review-layout.svelte';
  import Icon from './Icon.svelte';
  let { children }: { children: Snippet } = $props();
  const review = new ReviewLayoutState();
  setContext(reviewKey, review);
  let host: HTMLDivElement;
  let root: HTMLDivElement;
  let width = $state(1200);
  let narrow = $derived(width < 820);
  onMount(() => {
    review.host = host;
    const resize = new ResizeObserver(([entry]) => {
      width = entry.contentRect.width;
    });
    resize.observe(root);
    return () => resize.disconnect();
  });
</script>

<div
  class="review-layout"
  class:review-open={!!review.current}
  class:review-narrow={narrow}
  bind:this={root}
>
  <div class="review-conversation" inert={narrow && !!review.current}>
    {@render children()}
  </div>
  <div class="review-details" hidden={!review.current}>
    <div class="review-mobile-nav">
      <button class="text-button" onclick={() => review.current?.close()}
        ><Icon name="panel" size={15} />返回对话</button
      >
    </div>
    <div class="review-panel-host" bind:this={host}></div>
  </div>
</div>

<style>
  .review-layout {
    display: flex;
    flex: 1;
    min-height: 0;
    min-width: 0;
    position: relative;
  }
  .review-conversation {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
    min-height: 0;
  }
  .review-details {
    display: flex;
    flex-direction: column;
    flex: 1 1 52%;
    min-width: 0;
    min-height: 0;
    border-inline-start: 1px solid var(--border);
    background: var(--bg);
  }
  .review-details[hidden] {
    display: none;
  }
  .review-open:not(.review-narrow) .review-conversation {
    flex: 1 1 48%;
  }
  .review-panel-host {
    flex: 1;
    min-height: 0;
    display: flex;
  }
  .review-mobile-nav {
    display: none;
  }
  .review-narrow.review-open .review-conversation {
    visibility: hidden;
  }
  .review-narrow .review-details {
    position: absolute;
    inset: 0;
    z-index: 3;
    border: 0;
  }
  .review-narrow .review-mobile-nav {
    display: flex;
    justify-content: space-between;
    padding: 8px 16px;
    border-bottom: 1px solid var(--border);
  }
  .review-mobile-nav button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
</style>
