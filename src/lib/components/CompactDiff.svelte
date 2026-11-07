<!-- 折叠只作用于已取得的上下文，不读取当前磁盘文件来补历史内容。 -->
<script lang="ts">
  import { tick } from 'svelte';
  import { compactDiff } from '../compact-diff';
  let { text, done }: { text: string; done: boolean } = $props();
  const model = $derived(compactDiff(text));
  let expanded = $state<Record<number, number>>({});
  let all = $state(false);
  let current = $state(-1);
  let root: HTMLDivElement;
  const hasFolds = $derived(model.sections.some((section) => section.folded));

  /** 以修改块作为锚点恢复本次展开位置，不持续接管用户滚动。 */
  async function resize(start: number, count: number): Promise<void> {
    const anchor = root.querySelector<HTMLElement>(`[data-section="${start}"]`);
    const top = anchor?.getBoundingClientRect().top;
    expanded = { ...expanded, [start]: count };
    await tick();
    if (anchor && top != null) {
      const scroller = root.closest('.change-panel-body');
      if (scroller)
        scroller.scrollTop += anchor.getBoundingClientRect().top - top;
      anchor.querySelector('button')?.focus({ preventScroll: true });
    }
  }
  function navigate(direction: number): void {
    current = Math.max(
      0,
      Math.min(model.changes.length - 1, current + direction),
    );
    const target = root.querySelector<HTMLElement>(
      `[data-change="${model.changes[current]}"]`,
    );
    // 只滚动审阅区，避免 scrollIntoView 同时移动外层对话。
    const scroller = root.closest('.change-panel-body');
    if (target && scroller)
      scroller.scrollTop +=
        target.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top;
  }
</script>

<div class="compact-diff" bind:this={root}>
  <div class="diff-toolbar">
    <span
      >{model.recognized ? '精简差异' : '原始差异'} · {model.changes.length} 处修改{done
        ? ''
        : '（读取中）'}</span
    >
    <div class="diff-actions">
      <button
        disabled={current <= 0}
        onclick={() => navigate(-1)}
        aria-label="上一处修改">↑</button
      >
      <button
        disabled={!model.changes.length || current >= model.changes.length - 1}
        onclick={() => navigate(1)}
        aria-label="下一处修改">↓</button
      >
      {#if hasFolds}<button
          onclick={() => {
            all = !all;
            expanded = {};
          }}>{all ? '收起未修改代码' : '展开全部上下文'}</button
        >{/if}
    </div>
  </div>
  {#if !model.recognized}<p class="tool-load-status">
      部分格式无法识别，已保留原始差异。
    </p>{/if}
  <!-- svelte-ignore a11y_no_noninteractive_tabindex (差异正文需要支持键盘阅读。) -->
  <div class="tool-code" role="region" aria-label="代码差异" tabindex="0">
    {#each model.sections as section (section.start)}
      {@const count = all
        ? section.rows.length
        : Math.min(section.rows.length, expanded[section.start] ?? 0)}
      {@const visibleRows = !section.folded
        ? section.rows
        : section.start < model.changes[0]
          ? section.rows.slice(section.rows.length - count)
          : section.rows.slice(0, count)}
      <div
        data-section={section.start}
        data-change={section.change ? section.start : undefined}
      >
        {#if section.folded}
          <div class="diff-fold">
            {#if count < section.rows.length}<button
                onclick={() =>
                  void resize(
                    section.start,
                    Math.min(section.rows.length, count + 20),
                  )}
                >··· 已隐藏 {section.rows.length - count} 行未修改代码 ··· 展开</button
              >
              <button
                onclick={() => void resize(section.start, section.rows.length)}
                >展开此段全部</button
              >{/if}
            {#if count > 0 && !all}<button
                onclick={() => void resize(section.start, 0)}
                >收起此段上下文</button
              >{/if}
          </div>
        {/if}
        <pre class="tool-code-lines"><code
            >{#each visibleRows as row}<span
                class="tool-code-line"
                class:diff-added={row.kind === 'added'}
                class:diff-removed={row.kind === 'removed'}
                class:diff-context={row.kind === 'context'}
                >{@html row.html}{row.text ? '' : '\u200b'}</span
              >{/each}</code
          ></pre>
      </div>
    {/each}
  </div>
</div>

<style>
  .diff-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 6px 12px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
    color: var(--muted);
    font-size: 12px;
  }
  .diff-actions,
  .diff-fold {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 4px;
  }
  button {
    font: inherit;
    color: var(--muted);
    background: transparent;
    border: 0;
    border-radius: 5px;
    padding: 5px 8px;
    min-height: 28px;
    cursor: pointer;
  }
  button:hover:not(:disabled) {
    background: var(--hover);
    color: var(--text);
  }
  button:disabled {
    opacity: 0.4;
    cursor: default;
  }
  button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  .diff-fold:empty {
    display: none;
  }
  .diff-fold {
    background: var(--surface);
    border-block: 1px solid var(--border);
    margin: 6px 0;
    padding: 2px 6px;
    font-size: 12px;
  }
  .tool-code {
    max-height: none;
    overflow: visible;
  }
</style>
