<!-- 通用模态边界：原生 dialog 负责焦点约束、Escape 与关闭后的焦点恢复。 -->
<script lang="ts">
  import { onMount, type Snippet } from 'svelte';
  import Icon from './Icon.svelte';
  /** onclose 由业务所有者负责改变打开状态；内容可使用 autofocus 指定初始焦点。 */
  let {
    title,
    onclose,
    children,
    wide = false,
  }: {
    title: string;
    onclose: () => void;
    children: Snippet;
    wide?: boolean;
  } = $props();
  let dialog: HTMLDialogElement;
  onMount(() => {
    const focused = document.activeElement as HTMLElement | null;
    dialog.showModal();
    return () => {
      dialog.close();
      focused?.focus();
    };
  });
</script>

<dialog
  bind:this={dialog}
  class:wide
  oncancel={(event) => {
    event.preventDefault();
    onclose();
  }}
  onclick={(event) => {
    if (event.target === dialog) onclose();
  }}
  onkeydown={() => {}}
>
  <section class="modal-inner">
    <header class="modal-header">
      <h2>{title}</h2>
      <button class="icon-button" aria-label="关闭弹层" onclick={onclose}
        ><Icon name="close" /></button
      >
    </header>
    {@render children()}
  </section>
</dialog>
