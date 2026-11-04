<!-- 命令菜单只在输入区域持有层级状态；执行由 Desktop 和白名单 Action 完成。 -->
<script lang="ts">
  import Composer from './Composer.svelte';
  import ModelControls from './ModelControls.svelte';
  import type { Desktop } from '../state/desktop.svelte';
  import type { Action } from '../types';
  import { errorMessage } from '../client';

  let {
    desktop,
    onsend,
  }: { desktop: Desktop; onsend: (mode?: 'steer' | 'followUp') => void } =
    $props();
  type Page =
    | 'settings'
    | 'auto_compaction'
    | 'steering_mode'
    | 'follow_up_mode'
    | 'model'
    | 'thinking'
    | 'resume'
    | 'fork'
    | 'tree'
    | 'tree_options';
  let page = $state<Page | null>(null);
  let busy = $state(false);
  let modelChanging = $state(false);
  let loading = $state(false);
  let error = $state('');
  let origin = $state('');
  let entries = $state<{ name: string; description?: string }[]>([]);
  let treeEntry = $state('');
  let loadGeneration = 0;
  const settings = [
    {
      name: '自动压缩',
      description: '上下文接近上限时压缩',
      page: 'auto_compaction' as const,
    },
    {
      name: '引导消息模式',
      description: '逐条或全部处理',
      page: 'steering_mode' as const,
    },
    {
      name: '后续消息模式',
      description: '逐条或全部处理',
      page: 'follow_up_mode' as const,
    },
  ];
  const titles: Record<Page, string> = {
    settings: '/settings · Pi 设置',
    auto_compaction: 'Pi 设置 / 自动压缩',
    steering_mode: 'Pi 设置 / 引导消息模式',
    follow_up_mode: 'Pi 设置 / 后续消息模式',
    model: '/model · 选择模型',
    thinking: '/thinking · 思考等级',
    resume: '/resume · 恢复会话',
    fork: '/fork · 选择分支起点',
    tree: '/tree · 选择节点',
    tree_options: '/tree · 导航选项',
  };
  let items = $derived.by(() => {
    if (page === 'settings') return settings;
    if (page === 'resume')
      return desktop.recentSessions.map((session) => ({
        name: session.path,
        description: `${session.name || session.preview || session.timestamp} · ${session.cwd}`,
      }));
    if (page === 'fork' || page === 'tree') return entries;
    if (page === 'tree_options')
      return [
        { name: '直接切换', description: '不生成分支摘要' },
        { name: '生成摘要后切换', description: '可能调用模型并产生费用' },
      ];
    if (page === 'model')
      return desktop.models.map((m) => ({
        name: `${m.provider}/${m.id}`,
        description: m.name,
      }));
    if (page === 'thinking') return desktop.levels.map((name) => ({ name }));
    if (page === 'auto_compaction') return [{ name: '开启' }, { name: '关闭' }];
    return [{ name: '逐条处理' }, { name: '全部处理' }];
  });
  let menu = $derived(
    page
      ? {
          title: titles[page],
          items,
          busy: busy || loading,
          canBack: !busy,
          error,
        }
      : undefined,
  );
  function open(name: string): boolean {
    if (
      !['settings', 'model', 'thinking', 'resume', 'fork', 'tree'].includes(
        name,
      )
    )
      return false;
    if (desktop.restoring) {
      desktop.notice = '正在恢复连接，完成后可执行命令；草稿仍可编辑。';
      return true;
    }
    if (desktop.connection !== 'ready') {
      desktop.error = 'Pi 已断开，请重新连接后执行命令；草稿仍可编辑。';
      return true;
    }
    if (desktop.run !== 'idle' || modelChanging) {
      desktop.error = '请等待当前任务结束后执行命令。';
      return true;
    }
    origin = desktop.draft;
    page = name as Page;
    error = '';
    if (name === 'fork' || name === 'tree') void loadEntries(name);
    return true;
  }
  async function loadEntries(kind: 'fork' | 'tree'): Promise<void> {
    const generation = ++loadGeneration;
    const runtime = desktop.runtimeId;
    const session = desktop.snapshot.sessionFile;
    entries = [];
    loading = true;
    try {
      let next: typeof entries;
      if (kind === 'fork') {
        const data = await desktop.action<{
          messages: { entryId: string; text: string }[];
        }>({ type: 'fork_messages' });
        next = data.messages.map((message) => ({
          name: message.entryId,
          description: message.text.slice(0, 240),
        }));
      } else {
        type Node = {
          id: string;
          parentId: string | null;
          label: string;
          text: string;
        };
        const data = await desktop.action<{ nodes: Node[] }>({
          type: 'session_tree',
        });
        next = [];
        const ids = new Set(data.nodes.map((node) => node.id));
        const children = new Map<string | null, Node[]>();
        for (const node of data.nodes) {
          const parent =
            node.parentId && ids.has(node.parentId) ? node.parentId : null;
          const siblings = children.get(parent) ?? [];
          siblings.push(node);
          children.set(parent, siblings);
        }
        const visited = new Set<string>();
        const stack = [...(children.get(null) ?? [])]
          .reverse()
          .map((node) => ({ node, depth: 0 }));
        while (stack.length) {
          const { node, depth } = stack.pop()!;
          if (visited.has(node.id)) continue;
          visited.add(node.id);
          next.push({
            name: node.id,
            description: `${'· '.repeat(Math.min(depth, 8))}${node.label} · ${node.text.slice(0, 180)}`,
          });
          const descendants = children.get(node.id) ?? [];
          for (let i = descendants.length - 1; i >= 0; i--)
            stack.push({ node: descendants[i], depth: depth + 1 });
        }
      }
      if (
        generation === loadGeneration &&
        runtime === desktop.runtimeId &&
        session === desktop.snapshot.sessionFile
      )
        entries = next;
    } catch (cause) {
      if (
        generation === loadGeneration &&
        runtime === desktop.runtimeId &&
        session === desktop.snapshot.sessionFile
      )
        error = errorMessage(cause);
    } finally {
      if (generation === loadGeneration) loading = false;
    }
  }
  function back(): void {
    if (busy) return;
    ++loadGeneration;
    loading = false;
    if (page === 'tree_options') {
      page = 'tree';
      error = '';
      return;
    }
    if (
      page &&
      ['auto_compaction', 'steering_mode', 'follow_up_mode'].includes(page)
    )
      page = 'settings';
    else {
      page = null;
      desktop.draft = origin;
    }
    error = '';
  }
  async function choose(name: string): Promise<void> {
    if (busy || loading || !page) return;
    if (page === 'settings') {
      page = settings.find((item) => item.name === name)!.page;
      return;
    }
    if (page === 'tree') {
      treeEntry = name;
      page = 'tree_options';
      return;
    }
    const target = page;
    const runtime = desktop.runtimeId;
    const session = desktop.snapshot.sessionFile;
    busy = true;
    error = '';
    try {
      if (desktop.run !== 'idle' || desktop.connection !== 'ready')
        throw new Error('请等待 Pi 空闲并连接后操作。');
      if (target === 'resume') {
        await desktop.switchSession(name);
        if (desktop.snapshot.sessionFile === session) {
          error = '会话未切换，可能已被扩展取消。';
          return;
        }
        page = null;
        return;
      }
      if (target === 'fork' || target === 'tree_options') {
        const result = await desktop.action<{
          cancelled?: boolean;
          text?: string;
        }>(
          target === 'fork'
            ? { type: 'fork', entryId: name }
            : {
                type: 'navigate_tree',
                entryId: treeEntry,
                summarize: name === '生成摘要后切换',
              },
        );
        if (result.cancelled) {
          error = '操作已被 Pi 扩展取消。';
          return;
        }
        await desktop.refreshCommandSession();
        if (runtime === desktop.runtimeId) {
          page = null;
          desktop.draft = target === 'fork' ? (result.text ?? '') : '';
        }
        return;
      }
      if (target === 'model') await desktop.setModel(name);
      else if (target === 'thinking') await desktop.setThinking(name);
      else {
        const action: Action =
          target === 'auto_compaction'
            ? { type: 'set_auto_compaction', enabled: name === '开启' }
            : {
                type:
                  target === 'steering_mode'
                    ? 'set_steering_mode'
                    : 'set_follow_up_mode',
                mode: name === '全部处理' ? 'all' : 'one-at-a-time',
              };
        await desktop.action(action);
        await desktop.syncState();
      }
      if (
        runtime !== desktop.runtimeId ||
        session !== desktop.snapshot.sessionFile
      )
        return;
      desktop.notice = `${titles[target]}：${name}`;
      if (target === 'model' || target === 'thinking') {
        page = null;
        desktop.draft = '';
      } else page = 'settings';
    } catch (cause) {
      if (
        runtime === desktop.runtimeId &&
        session === desktop.snapshot.sessionFile
      )
        error = errorMessage(cause);
    } finally {
      busy = false;
    }
  }
  function send(mode?: 'steer' | 'followUp'): void {
    const match = /^\/(settings|model|thinking|resume|fork|tree)\s*$/.exec(
      desktop.draft.trim(),
    );
    if (match && !desktop.images.length && open(match[1])) return;
    onsend(mode);
  }
  // 连接或会话变化时关闭菜单，旧页面不能作用于新会话。
  $effect(() => {
    desktop.runtimeId;
    desktop.snapshot.sessionFile;
    ++loadGeneration;
    loading = false;
    page = null;
  });
</script>

{#if desktop.recoveredImages.length}<div
    role="group"
    aria-label="可恢复的未发送消息"
  >
    {#each desktop.recoveredImages as draft, index}<button
        type="button"
        onclick={() => desktop.restoreImages(index)}
        >恢复{draft.images.length
          ? `图片消息（${draft.images.length} 张）`
          : '未发送消息'}{draft.text.slice(0, 60)}</button
      >{/each}
  </div>{/if}
<Composer
  bind:value={desktop.draft}
  bind:parts={desktop.draftParts}
  bind:images={desktop.images}
  historyKey={JSON.stringify([
    desktop.runtimeId,
    desktop.project,
    desktop.snapshot.sessionFile,
    desktop.newChatProject,
    desktop.openingSession?.path,
  ])}
  onhistory={(before) => desktop.promptHistory(before)}
  onhistorytext={(message) => desktop.promptText(message)}
  disabled={!!desktop.openingSession ||
    (!desktop.historyCached &&
      ['starting', 'stopping'].includes(desktop.connection))}
  running={desktop.run !== 'idle'}
  submitting={desktop.submitting ||
    desktop.waitingToSend ||
    modelChanging ||
    busy ||
    loading ||
    (!desktop.historyCached &&
      desktop.connection !== 'ready' &&
      desktop.newChatProject === null) ||
    desktop.task?.state === 'queued'}
  unavailableCommands={[
    ...(!desktop.commands.some(
      (command) => command.name === 'pi-desktop-reload-v1',
    ) ||
    !desktop.commands.some((command) => command.name === 'pi-desktop-models-v1')
      ? ['reload']
      : []),
    ...(!desktop.commands.some(
      (command) => command.name === 'pi-desktop-navigate-v1',
    )
      ? ['tree']
      : []),
  ]}
  commands={desktop.commands.filter(
    (command) => !command.name.startsWith('pi-desktop-'),
  )}
  {menu}
  oncommand={open}
  onchoose={(name) => {
    void choose(name);
  }}
  onback={back}
  onsend={send}
  onstop={() => {
    void desktop.guard(() => desktop.stop());
  }}
>
  {#snippet controls()}
    <ModelControls
      {desktop}
      bind:busy={modelChanging}
      disabled={busy || loading || page !== null || desktop.restoring}
    />
  {/snippet}
</Composer>
