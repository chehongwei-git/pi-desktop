<!-- 内置命令由桌面执行；RPC 不支持的终端功能提供明确入口说明。 -->
<script lang="ts">
  import { onMount } from 'svelte';
  import Modal from './Modal.svelte';
  import type { Desktop } from '../state/desktop.svelte';
  import { errorMessage } from '../client';
  import { builtinCommands } from '../commands';

  let {
    desktop,
    name,
    args,
    onclose,
  }: {
    desktop: Desktop;
    name: string;
    args: string;
    onclose: () => void;
  } = $props();
  let value = $state('');
  let busy = $state(false);
  let error = $state('');
  let output = $state('');
  let choices = $state<{ value: string; label: string }[]>([]);
  const terminalOnly: Record<string, string> = {
    'scoped-models':
      '模型轮换范围属于终端设置；桌面端可直接在模型选择器中切换。',
    import: 'Pi RPC 尚未提供 JSONL 导入接口。',
    share: 'Pi RPC 尚未提供分享接口。',
    bug: 'Pi 的问题报告向导需要终端交互。',
    trust: '项目信任设置需要在 Pi 终端中完成。',
    login: '提供商登录需要 Pi 终端中的身份验证流程。',
    logout: 'Pi RPC 尚未提供移除身份验证的接口。',
    changelog: 'Pi RPC 尚未提供更新日志接口。',
  };
  let description = $derived(
    builtinCommands.find((command) => command.name === name)?.description ??
      name,
  );
  let needsInput = $derived(
    [
      'model',
      'thinking',
      'name',
      'export',
      'compact',
      'resume',
      'fork',
      'tree',
    ].includes(name),
  );

  async function work(task: () => Promise<void>): Promise<void> {
    if (busy) return;
    busy = true;
    error = '';
    try {
      await task();
    } catch (cause) {
      error = errorMessage(cause);
    } finally {
      busy = false;
    }
  }
  async function execute(): Promise<void> {
    await work(async () => {
      if (desktop.connection !== 'ready' || desktop.run !== 'idle')
        throw new Error('请等待 Pi 空闲并连接后再执行命令。');
      const input = value.trim();
      switch (name) {
        case 'model':
          if (!choices.some((choice) => choice.value === input))
            throw new Error('请选择有效模型。');
          await desktop.setModel(input);
          output = `已选择模型：${input}`;
          break;
        case 'thinking':
          if (!desktop.levels.includes(input))
            throw new Error('请选择当前模型支持的思考级别。');
          await desktop.setThinking(input);
          output = `思考级别：${input}`;
          break;
        case 'name':
          if (!input) {
            output = `当前会话名称：${desktop.sessionTitle}`;
            break;
          }
          await desktop.rename(input);
          output = `会话名称：${input}`;
          break;
        case 'new':
          await desktop.newSession();
          onclose();
          break;
        case 'resume':
          if (!input) throw new Error('请选择会话或输入会话文件的绝对路径。');
          await desktop.switchSession(input);
          onclose();
          break;
        case 'quit':
          await desktop.disconnect();
          onclose();
          break;
        case 'compact':
          await desktop.action({
            type: 'compact',
            instructions: input || undefined,
          });
          await desktop.refreshCommandSession();
          output = '会话上下文已压缩。';
          break;
        case 'clone':
        case 'fork': {
          if (name === 'fork' && !input) throw new Error('请选择分支起点。');
          const result = await desktop.action<{
            cancelled?: boolean;
            text?: string;
          }>(
            name === 'clone'
              ? { type: 'clone' }
              : { type: 'fork', entryId: input },
          );
          if (result.cancelled) {
            output = '操作已被 Pi 扩展取消。';
            break;
          }
          await desktop.refreshCommandSession();
          if (result.text) desktop.draft = result.text;
          output =
            name === 'clone'
              ? '已复制当前会话。'
              : '已创建分支，原消息已恢复到输入框。';
          break;
        }
        case 'export': {
          if (input && !/\.html?$/i.test(input))
            throw new Error(
              'RPC 支持导出 HTML，请使用 .html 文件路径；JSONL 导出请使用 Pi 终端。',
            );
          const result = await desktop.action<{ path: string }>({
            type: 'export',
            path: input || undefined,
          });
          output = `已导出：${result.path}`;
          break;
        }
        case 'copy': {
          const result = await desktop.action<{ text: string | null }>({
            type: 'last_assistant',
          });
          if (!result.text) throw new Error('当前会话还没有助手回复。');
          await navigator.clipboard.writeText(result.text);
          output = '已复制最后一条助手回复。';
          break;
        }
        case 'session':
          output = JSON.stringify(
            await desktop.action({ type: 'session_stats' }),
            null,
            2,
          );
          break;
        case 'tree':
          if (!input) throw new Error('请选择树节点。');
          await desktop.action({
            type: 'navigate_tree',
            entryId: input,
            summarize: false,
          });
          await desktop.refreshCommandSession();
          output = '已切换到所选会话树节点。';
          break;
        case 'reload': {
          try {
            await desktop.action({ type: 'reload' });
          } finally {
            // 部分失败也可能更新模型列表；刷新展示，但不重读完整历史或重启 Pi。
            await Promise.all([desktop.syncState(), desktop.refreshMetadata()]);
          }
          output = '已重载项目资源和本地模型配置，并重新应用当前模型。';
          break;
        }
        case 'hotkeys':
          output =
            'Enter：发送消息或运行命令\nShift + Enter：换行\n↑ / ↓：选择命令\nTab / Enter：补全命令\nEscape：收起命令菜单\n运行中 Enter：发送引导\n运行中“完成后发送”：排队后续消息';
          break;
      }
    });
  }
  onMount(() => {
    value = args;
    void work(async () => {
      if (terminalOnly[name]) {
        output = `${terminalOnly[name]}\n\n请在项目目录启动 pi，然后运行：\n/${name}${args ? ` ${args}` : ''}`;
        return;
      }
      if (name === 'model')
        choices = desktop.models.map((model) => ({
          value: `${model.provider}/${model.id}`,
          label: `${model.name} · ${model.provider}`,
        }));
      if (name === 'thinking')
        choices = desktop.levels.map((level) => ({
          value: level,
          label: level,
        }));
      if (name === 'resume')
        choices = desktop.recentSessions.map((session) => ({
          value: session.path,
          label: `${session.name || session.preview || session.timestamp} · ${session.cwd}`,
        }));
      if (name === 'tree') {
        type Node = {
          entry: {
            id: string;
            type: string;
            message?: { role?: string; content?: { text?: string }[] };
          };
          children: Node[];
        };
        const result = await desktop.action<{ tree: Node[] }>({
          type: 'session_tree',
        });
        const stack = [...(result.tree ?? [])]
          .reverse()
          .map((node) => ({ node, depth: 0 }));
        while (stack.length) {
          const { node, depth } = stack.pop()!;
          choices.push({
            value: node.entry.id,
            label: `${'· '.repeat(Math.min(depth, 8))}${node.entry.message?.role ?? node.entry.type} · ${node.entry.message?.content?.find((block) => block.text)?.text?.slice(0, 120) ?? node.entry.id}`,
          });
          for (let i = node.children.length - 1; i >= 0; i--)
            stack.push({ node: node.children[i], depth: depth + 1 });
        }
        if (!choices.length) output = '当前会话树为空。';
      }
      if (name === 'fork') {
        const result = await desktop.action<{
          messages: { entryId: string; text: string }[];
        }>({ type: 'fork_messages' });
        choices = result.messages.map((message) => ({
          value: message.entryId,
          label: message.text,
        }));
        if (!choices.length) output = '当前会话没有可用于创建分支的用户消息。';
      }
      if (name === 'name' && !args)
        output = `当前会话名称：${desktop.sessionTitle}`;
      if (!value && choices.length) value = choices[0].value;
    }).then(() => {
      if (
        !terminalOnly[name] &&
        !error &&
        (!needsInput ||
          (args &&
            !['compact', 'export', 'resume', 'fork', 'tree'].includes(name)))
      )
        void execute();
    });
  });
</script>

<Modal
  title={`/${name} · ${description}`}
  onclose={() => {
    if (!busy) onclose();
  }}
  wide={name === 'tree' || name === 'session'}
>
  {#if error}<p class="dialog-message" role="alert">{error}</p>{/if}
  {#if busy}<p class="dialog-message" role="status">正在执行 /{name}…</p>{/if}
  {#if needsInput && !terminalOnly[name]}
    <form
      onsubmit={(event) => {
        event.preventDefault();
        void execute();
      }}
    >
      {#if choices.length}
        <label class="dialog-field"
          >{description}
          <select bind:value disabled={busy}>
            {#each choices as choice}<option value={choice.value}
                >{choice.label}</option
              >{/each}
          </select>
        </label>
      {:else if name !== 'fork'}
        <label class="dialog-field"
          >{description}
          <input
            bind:value
            disabled={busy}
            placeholder={builtinCommands.find(
              (command) => command.name === name,
            )?.argumentHint ?? ''}
          />
        </label>
      {/if}
      <footer class="modal-actions">
        <button
          type="submit"
          class="primary"
          disabled={busy || (name === 'fork' && !choices.length)}>执行</button
        >
      </footer>
    </form>
  {/if}
  {#if output}<pre class="command-output">{output}</pre>{/if}
  <footer class="modal-actions">
    {#if terminalOnly[name]}<button
        onclick={() => {
          void work(async () => {
            await navigator.clipboard.writeText(
              `/${name}${args ? ` ${args}` : ''}`,
            );
          });
        }}>复制命令</button
      >{/if}
    {#if error && !needsInput && !terminalOnly[name]}<button
        disabled={busy}
        onclick={() => {
          void execute();
        }}>重试</button
      >{/if}
    <button onclick={onclose} disabled={busy}>关闭</button>
  </footer>
</Modal>
