<!-- 输入器只有草稿与提交意图，不知道 RPC；组合输入、自动高度和发送模式在此收敛。 -->
<script lang="ts">
  import Icon from './Icon.svelte';
  import { shouldSend } from '../state/reducer';
  import { mergeCommands } from '../commands';
  import type { Command } from '../types';
  /** 运行中 Enter/发送直接引导当前任务，后续消息与停止使用独立按钮。 */
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
  let selected = $state(0);
  let dismissed = $state('');
  const menuId = $props.id();
  let matches = $derived(
    !disabled &&
      value.startsWith('/') &&
      !/\s/.test(value) &&
      dismissed !== value
      ? mergeCommands(commands).filter((command) =>
          command.name.toLowerCase().includes(value.slice(1).toLowerCase()),
        )
      : [],
  );
  $effect(() => {
    value;
    selected = 0;
  });
  $effect(() => {
    if (matches[selected])
      document
        .getElementById(`${menuId}-${selected}`)
        ?.scrollIntoView?.({ block: 'nearest' });
  });
  function complete(index: number): void {
    const command = matches[index];
    if (!command) return;
    value = `/${command.name} `;
    dismissed = '';
    textarea.focus();
  }
  $effect(() => {
    value;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
    }
  });
  /** 模式在按钮与提示中明确表达；提交期间阻止重复请求。 */
  function submit(mode?: 'steer' | 'followUp'): void {
    if (!value.trim() || disabled || submitting) return;
    onsend(mode ?? (running ? 'steer' : undefined));
  }
  /** IME 回车由浏览器确认候选；只有非组合输入才 preventDefault 并发送。 */
  function keydown(event: KeyboardEvent): void {
    if (composing || event.isComposing || event.keyCode === 229) return;
    if (
      matches.length &&
      !event.shiftKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      if (event.key === 'Escape') {
        event.preventDefault();
        dismissed = value;
        return;
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        selected =
          (selected + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) %
          matches.length;
        return;
      }
      if (event.key === 'Tab' || event.key === 'Enter') {
        event.preventDefault();
        complete(selected);
        return;
      }
    }
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
      id={menuId}
      aria-label="Pi 命令"
    >
      {#each matches as command, index}<button
          id={`${menuId}-${index}`}
          role="option"
          aria-selected={selected === index}
          class:active={selected === index}
          tabindex="-1"
          onpointermove={() => {
            selected = index;
          }}
          onmousedown={(event) => event.preventDefault()}
          onclick={() => complete(index)}
          ><strong>/{command.name}</strong><small
            >{command.argumentHint
              ? `${command.argumentHint} · `
              : ''}{command.description ?? command.source}</small
          ></button
        >{/each}
    </div>{/if}
  <textarea
    bind:this={textarea}
    bind:value
    rows="1"
    placeholder={disabled
      ? '先选择项目文件夹，再开始对话'
      : running
        ? '补充要求或调整方向，引导当前任务'
        : '向 Pi 发送消息'}
    aria-label="消息输入"
    aria-controls={matches.length ? menuId : undefined}
    aria-activedescendant={matches.length ? `${menuId}-${selected}` : undefined}
    oninput={() => {
      dismissed = '';
    }}
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
        ? 'Enter 发送引导 · Shift + Enter 换行'
        : 'Shift + Enter 换行'}</span
    >
    <div class="composer-actions">
      {#if running}
        <button
          class="text-button"
          title="排在当前任务完成后处理"
          disabled={disabled || submitting || !value.trim()}
          onclick={() => submit('followUp')}>完成后发送</button
        >
        <button
          class="send-button stop-button"
          aria-label="停止任务"
          title="停止任务"
          {disabled}
          onclick={onstop}><Icon name="stop" size={18} /></button
        >
      {/if}
      <button
        class="send-button"
        class:steer-button={running}
        aria-label={running ? '发送引导' : '发送消息'}
        title={running ? '发送引导，在下一个可处理节点生效' : '发送消息'}
        disabled={disabled || !value.trim() || submitting}
        onclick={() => submit()}
        >{#if running}<span>发送引导</span>{/if}<Icon
          name="arrow"
          size={19}
        /></button
      >
    </div>
  </div>
</div>
