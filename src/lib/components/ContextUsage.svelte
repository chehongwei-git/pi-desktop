<!-- 上下文使用率：右下角折叠态只报百分比与窗口，点击就地展开明细，不弹窗。 -->
<script lang="ts">
  import { tick } from 'svelte';
  import type { Desktop } from '../state/desktop.svelte';
  import {
    cacheHitRate,
    contextLabel,
    formatCost,
    formatPercent,
    formatTokens,
    usageTone,
  } from '../usage';

  let { desktop }: { desktop: Desktop } = $props();
  const panelId = $props.id();
  let expanded = $state(false);
  let root = $state<HTMLDivElement>();
  let trigger = $state<HTMLButtonElement>();

  // 本地新对话尚未创建 Pi 会话，不能把后台旧会话的用量当成新对话读数。
  const usage = $derived(
    desktop.connection === 'ready' &&
      !desktop.restoring &&
      desktop.newChatProject === null &&
      !desktop.openingSession
      ? desktop.stats?.contextUsage
      : undefined,
  );
  $effect(() => {
    desktop.runtimeId;
    desktop.snapshot.sessionFile;
    desktop.newChatProject;
    expanded = false;
  });
  const label = $derived(contextLabel(usage));
  const tone = $derived(usageTone(usage?.percent));
  const auto = $derived(desktop.snapshot.autoCompactionEnabled === true);
  /** 阈值含义写进无障碍名称，不能只靠颜色区分。 */
  const description = $derived(
    usage
      ? `上下文使用率 ${formatPercent(usage.percent)}%，已用 ${formatTokens(
          usage.tokens,
        )}，上限 ${formatTokens(usage.contextWindow)}${
          auto ? '，已开启自动压缩' : ''
        }${tone === 'error' ? '，接近上限' : tone === 'warning' ? '，已较接近上限' : ''}`
      : '',
  );

  function close(restore = false): void {
    if (!expanded) return;
    expanded = false;
    if (restore) trigger?.focus({ preventScroll: true });
  }

  /** 展开时刷新一次统计，避免展示上次任务结束时的旧数字。 */
  async function toggle(): Promise<void> {
    if (expanded) {
      close(true);
      return;
    }
    expanded = true;
    void desktop.refreshStats();
    await tick();
    // 刷新期间按钮会短暂禁用（禁用元素无法获得焦点），先在面板上停留焦点。
    root
      ?.querySelector<HTMLElement>('.context-usage-panel')
      ?.focus({ preventScroll: true });
  }

  function keydown(event: KeyboardEvent): void {
    if (!root?.contains(event.target as Node)) return;
    if (event.key === 'Escape' && expanded) {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    }
  }
</script>

<svelte:window
  onpointerdown={(event) => {
    if (expanded && !root?.contains(event.target as Node)) close();
  }}
  onkeydown={keydown}
/>
{#if usage}
  <div
    class="context-usage"
    bind:this={root}
    onfocusout={(event) => {
      if (!root?.contains(event.relatedTarget as Node)) close();
    }}
  >
    <button
      type="button"
      class="context-usage-trigger"
      bind:this={trigger}
      data-tone={tone}
      aria-label={description}
      aria-expanded={expanded}
      aria-controls={expanded ? panelId : undefined}
      title={`${description}（点击查看明细）`}
      onclick={() => {
        void toggle();
      }}
    >
      <span class="context-usage-value">{label}</span>
      {#if auto}<span class="context-usage-auto">自动</span>{/if}
    </button>
    {#if expanded}
      <div
        class="context-usage-panel"
        id={panelId}
        role="group"
        aria-label="上下文用量明细"
        tabindex="-1"
      >
        <div class="context-usage-heading">
          <strong>上下文与用量</strong>
          <span>统计来自当前会话，包含工具与压缩摘要</span>
        </div>
        <dl class="usage-grid">
          <dt>上下文</dt>
          <dd>
            {formatTokens(usage.tokens)} / {formatTokens(usage.contextWindow)}
            <small>（{formatPercent(usage.percent)}%）</small>
          </dd>
          <dt>累计输入</dt>
          <dd>{formatTokens(desktop.stats?.tokens.input)}</dd>
          <dt>累计输出</dt>
          <dd>{formatTokens(desktop.stats?.tokens.output)}</dd>
          <dt>缓存读取</dt>
          <dd>{formatTokens(desktop.stats?.tokens.cacheRead)}</dd>
          <dt>缓存写入</dt>
          <dd>{formatTokens(desktop.stats?.tokens.cacheWrite)}</dd>
          <dt>缓存命中</dt>
          <dd>
            {desktop.stats ? cacheHitRate(desktop.stats.tokens) : '—'}
            <small>（按会话累计）</small>
          </dd>
          <dt>费用</dt>
          <dd>{formatCost(desktop.stats?.cost)}</dd>
          <dt>消息</dt>
          <dd>
            用户 {desktop.stats?.userMessages ?? 0} · 助手 {desktop.stats
              ?.assistantMessages ?? 0} · 工具 {desktop.stats?.toolCalls ?? 0}
          </dd>
        </dl>
        {#if usage.tokens === null}
          <p class="context-usage-note" role="status">
            压缩后需要等待下一次回答才能估算上下文用量。
          </p>
        {/if}
        <div class="context-usage-actions">
          <button
            type="button"
            class="text-button"
            disabled={desktop.statsLoading}
            onclick={() => {
              void desktop.refreshStats();
            }}>{desktop.statsLoading ? '正在刷新…' : '刷新统计'}</button
          >
          <span class="context-usage-hint">Esc 收起</span>
        </div>
      </div>
    {/if}
  </div>
{/if}
