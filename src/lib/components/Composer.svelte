<!-- 输入器只有草稿与提交意图，不知道 RPC；组合输入、自动高度和发送模式在此收敛。 -->
<script lang="ts">
  import Icon from './Icon.svelte';
  import { shouldSend } from '../state/reducer';
  import type { Command } from '../types';
  /** running 时主按钮停止；回车通过显式模式菜单选择 steer/followUp，绝不隐式猜测。 */
  let {
    value = $bindable(''),
    disabled = false,
    running = false,
    submitting = false,
    commands = [],
    onsend,
    onstop,
  }: {
    value?: string;
    disabled?: boolean;
    running?: boolean;
    submitting?: boolean;
    commands?: Command[];
    onsend: (mode?: 'steer' | 'followUp') => void;
    onstop: () => void;
  } = $props();
  let textarea: HTMLTextAreaElement;
  let composing = false;
  let modeMenu = $state(false);
  let matches = $derived(
    value.startsWith('/') && !value.includes('\n')
      ? commands
          .filter((c) =>
            c.name.toLowerCase().includes(value.slice(1).toLowerCase()),
          )
          .slice(0, 6)
      : [],
  );
  $effect(() => {
    value;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
    }
  });
  /** 运行中提交先显示选择，不清空草稿。 */
  function submit(): void {
    if (!value.trim() || disabled || submitting) return;
    if (running) modeMenu = true;
    else onsend();
  }
  /** IME 回车由浏览器确认候选；只有非组合输入才 preventDefault 并发送。 */
  function keydown(event: KeyboardEvent): void {
    if (shouldSend(event, composing)) {
      event.preventDefault();
      submit();
    }
  }
</script>

<div class="composer" class:disabled>
  {#if matches.length}<div
      class="slash-menu"
      role="listbox"
      aria-label="Pi 命令"
    >
      {#each matches as command}<button
          role="option"
          aria-selected="false"
          onclick={() => {
            value = `/${command.name} `;
            textarea.focus();
          }}
          ><strong>/{command.name}</strong><small
            >{command.description ?? command.source}</small
          ></button
        >{/each}
    </div>{/if}
  <textarea
    bind:this={textarea}
    bind:value
    rows="1"
    placeholder={disabled ? '先选择项目文件夹，再开始对话' : '向 Pi 发送消息'}
    aria-label="消息输入"
    {disabled}
    onkeydown={keydown}
    oncompositionstart={() => {
      composing = true;
    }}
    oncompositionend={() => {
      composing = false;
    }}></textarea>
  <div class="composer-bottom">
    <span class="composer-hint"
      >{running
        ? '任务运行中 · 可发送引导或后续消息'
        : 'Shift + Enter 换行'}</span
    >
    <div class="composer-actions">
      {#if running && value.trim()}<button
          class="text-button"
          onclick={() => {
            modeMenu = !modeMenu;
          }}
          disabled={submitting}>发送消息</button
        >{/if}
      <button
        class="send-button"
        aria-label={running ? '停止任务' : '发送消息'}
        title={running ? '停止任务' : '发送消息'}
        disabled={disabled || (!running && (!value.trim() || submitting))}
        onclick={() => (running ? onstop() : submit())}
        ><Icon name={running ? 'stop' : 'arrow'} size={19} /></button
      >
    </div>
  </div>
  {#if modeMenu}<div class="send-menu">
      <button
        onclick={() => {
          modeMenu = false;
          onsend('steer');
        }}>引导当前任务<small>在本轮工具执行后处理</small></button
      ><button
        onclick={() => {
          modeMenu = false;
          onsend('followUp');
        }}>完成后发送<small>排在当前任务之后</small></button
      ><button
        class="muted"
        onclick={() => {
          modeMenu = false;
        }}>取消</button
      >
    </div>{/if}
</div>
