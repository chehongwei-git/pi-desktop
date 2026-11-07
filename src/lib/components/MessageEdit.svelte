<!-- 与底部草稿隔离，复用文字与附件编辑器；状态说明保持在操作附近。 -->
<script lang="ts">
  import { onMount, tick } from 'svelte';
  import DraftEditor from './DraftEditor.svelte';
  import DraftAttachments from './DraftAttachments.svelte';
  import type { MessageEdit } from '../message-edit';
  let {
    edit,
    unavailable = '',
    onsend,
    oncancel,
  }: {
    edit: MessageEdit;
    unavailable?: string;
    onsend: () => void;
    oncancel: () => void;
  } = $props();
  let editor: DraftEditor;
  let composing = false;
  let discard = $state(false);
  let initial = '';
  onMount(() => {
    initial = JSON.stringify(edit.draft);
    void tick().then(() => editor?.focus());
  });
  function cancel(): void {
    if (edit.busy) return;
    if (!discard && JSON.stringify(edit.draft) !== initial) {
      discard = true;
      return;
    }
    oncancel();
  }
  function keydown(event: KeyboardEvent): void {
    if (composing || event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      cancel();
    }
    if (
      event.key === 'Enter' &&
      (event.ctrlKey || event.metaKey) &&
      !event.shiftKey &&
      !unavailable &&
      !edit.busy &&
      !edit.uncertain
    ) {
      event.preventDefault();
      onsend();
    }
  }
</script>

<div class="inline-message-edit" role="group" aria-label="编辑已发送消息">
  <div class="edit-surface" inert={edit.busy}>
    {#if edit.draft.attachments.length}<DraftAttachments
        bind:attachments={edit.draft.attachments}
        historyKey={edit.message.id}
        onempty={() => editor?.focus()}
      />{/if}
    <DraftEditor
      bind:this={editor}
      bind:value={edit.draft.text}
      bind:parts={edit.draft.parts}
      label="编辑消息内容"
      disabled={edit.busy}
      context={edit.message.id}
      onkeydown={keydown}
      onpaste={() => {}}
      oninput={() => {
        discard = false;
      }}
      oncompositionstart={() => {
        composing = true;
      }}
      oncompositionend={() => {
        composing = false;
      }}
    />
  </div>
  <div class="edit-footer">
    <span class="edit-hint"
      >{discard
        ? '放弃修改？再次点击取消即可退出。'
        : '从此处重新回答，文件不回退。'}</span
    >
    <div class="edit-actions">
      <button
        type="button"
        class="text-button"
        disabled={edit.busy}
        onclick={cancel}>取消</button
      ><button
        type="button"
        class="primary"
        disabled={edit.busy ||
          !!unavailable ||
          edit.uncertain ||
          (!edit.draft.text.trim() && !edit.draft.attachments.length)}
        onclick={onsend}>发送</button
      >
    </div>
  </div>
  {#if edit.busy}<div class="edit-feedback" role="status">
      正在发送…
    </div>{:else if edit.error}<div
      class="edit-feedback error-text"
      role="alert"
    >
      {edit.error}
    </div>{:else if unavailable}<div class="edit-feedback" role="status">
      {unavailable}
    </div>{/if}
</div>

<style>
  .inline-message-edit {
    width: min(100%, 720px);
    min-width: 0;
  }
  .edit-surface {
    padding: 14px 16px;
    border: 1px solid var(--border);
    border-radius: 16px;
    background: var(--input-surface);
  }
  .edit-surface:focus-within {
    border-color: var(--accent);
  }
  .edit-surface :global(textarea) {
    display: block;
    width: 100%;
    min-height: 64px;
    max-height: 200px;
    resize: none;
    border: 0;
    outline: none;
    padding: 0;
    background: transparent;
    color: var(--text);
    font: inherit;
    line-height: 1.7;
  }
  .edit-footer {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px 16px;
    margin-top: 10px;
  }
  .edit-hint,
  .edit-feedback {
    color: var(--muted);
    font-size: 12px;
    line-height: 1.6;
  }
  .edit-actions {
    display: flex;
    gap: 8px;
    margin-inline-start: auto;
  }
  .edit-actions button {
    min-height: 32px;
    padding: 5px 14px;
    border-radius: 9px;
    font-size: 13px;
  }
  .edit-feedback {
    margin-top: 8px;
  }
  .error-text {
    color: var(--error);
  }
</style>
