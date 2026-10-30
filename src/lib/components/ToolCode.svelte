<!-- 长正文使用定高行窗口，完整文本保留可滚动浏览，不因 CSS 高度而丢失内容。 -->
<script lang="ts">
  import { colorCode, diffRows, escapeText } from '../tool-presentation';
  let {
    text,
    language,
    diff = false,
    onend = () => {},
  }: {
    text: string;
    language?: string;
    diff?: boolean;
    onend?: () => void;
  } = $props();
  let viewport = $state<HTMLDivElement>();
  let top = $state(0);
  let height = $state(400);
  let html = $state<string[]>([]);
  let rows = $derived(text.split('\n'));
  let virtual = $derived(rows.length > 200);
  let start = $derived(virtual ? Math.max(0, Math.floor(top / 21) - 8) : 0);
  let end = $derived(
    virtual
      ? Math.min(rows.length, start + Math.ceil(height / 21) + 16)
      : rows.length,
  );
  let visible = $derived(
    diff
      ? diffRows(rows.slice(start, end).join('\n'))
      : rows
          .slice(start, end)
          .map((text) => ({ text, kind: 'context', html: escapeText(text) })),
  );
  $effect(() => {
    const current = visible;
    const lang = language;
    let alive = true;
    html = current.map((row) => row.html);
    if (!diff && lang)
      void Promise.all(current.map((row) => colorCode(row.text, lang)))
        .then((result) => {
          if (alive) html = result;
        })
        .catch(() => {});
    return () => {
      alive = false;
    };
  });
  $effect(() => {
    if (!viewport) return;
    const observer = new ResizeObserver(() => {
      if (viewport) height = viewport.clientHeight;
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  });
  function scroll(): void {
    if (!viewport) return;
    top = viewport.scrollTop;
    if (viewport.scrollHeight - top - viewport.clientHeight < 160) onend();
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex (长输出滚动区需要键盘滚动与焦点。) -->
<div
  class="tool-code"
  class:virtual-code={virtual}
  bind:this={viewport}
  role="region"
  aria-label={diff ? '代码差异' : '工具正文'}
  tabindex="0"
  onscroll={scroll}
>
  <pre
    class="tool-code-lines"
    style:padding-top={`${start * 21}px`}
    style:padding-bottom={`${(rows.length - end) * 21}px`}><code
      class={language ? `language-${language} hljs` : ''}
      >{#each visible as row, index}<span
          class="tool-code-line"
          class:diff-added={diff && row.kind === 'added'}
          class:diff-removed={diff && row.kind === 'removed'}
          class:diff-context={diff && row.kind === 'context'}
          >{@html html[index] ?? row.html}{row.text ? '' : '\u200b'}</span
        >{/each}</code
    ></pre>
</div>
