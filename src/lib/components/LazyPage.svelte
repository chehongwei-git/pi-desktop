<!-- 管理页面按需加载；等待与失败均在原内容区完成，不影响后台会话。 -->
<script lang="ts" generics="T">
  import { tick, untrack, type Snippet } from 'svelte';
  import Icon from './Icon.svelte';

  let {
    title,
    load,
    onclose,
    children,
  }: {
    title: string;
    load: () => Promise<{ default: T }>;
    onclose: () => void;
    children: Snippet<[T]>;
  } = $props();
  // 每次挂载只发起一次加载；原生 import 缓存成功模块，失败可显式重试。
  // await 块随组件卸载失效，迟到的结果不能重新打开页面或抢夺焦点。
  let pending = $state(untrack(() => load()));
  let back = $state<HTMLButtonElement>();
  // await 的等待分支可能晚于 onMount 挂载，绑定就绪后再设置焦点。
  $effect(() => {
    back?.focus({ preventScroll: true });
  });
  async function retry(): Promise<void> {
    pending = load();
    await tick();
    back?.focus({ preventScroll: true });
  }
</script>

<!-- 加载占位也遵循页面 Escape 返回；就绪后由实际页面处理草稿保护。 -->
<svelte:window
  onkeydown={(event) => {
    if (
      event.key === 'Escape' &&
      !event.defaultPrevented &&
      back?.isConnected
    ) {
      event.preventDefault();
      onclose();
    }
  }}
/>

{#await pending}
  <section class="lazy-page" aria-label={title} aria-busy="true">
    <header>
      <button bind:this={back} class="text-button" onclick={onclose}>
        <Icon name="close" size={16} />返回
      </button>
      <h1>{title}</h1>
    </header>
    <p role="status">正在加载{title}…</p>
  </section>
{:then page}
  {@render children(page.default)}
{:catch}
  <section class="lazy-page" aria-label={title}>
    <header>
      <button bind:this={back} class="text-button" onclick={onclose}>
        <Icon name="close" size={16} />返回
      </button>
      <h1>{title}</h1>
    </header>
    <p role="alert">暂时无法加载{title}，请重试。当前对话和草稿仍然保留。</p>
    <button class="text-button" onclick={() => void retry()}>重试加载</button>
  </section>
{/await}

<style>
  .lazy-page {
    flex: 1;
    min-height: 0;
    padding: 24px;
    overflow: auto;
  }
  header {
    display: flex;
    align-items: center;
    gap: 16px;
  }
  h1 {
    margin: 0;
    font-size: 18px;
  }
  p {
    color: var(--muted);
    line-height: 1.6;
  }
</style>
