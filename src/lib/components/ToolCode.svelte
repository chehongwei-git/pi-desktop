<!-- 正文采用普通布局与独立滚动框，不再测量行高或写入对话滚动位置。 -->
<script lang="ts">
  import { colorCode, diffRows, escapeText } from '../tool-presentation';
  let {
    text,
    language,
    diff = false,
  }: {
    text: string;
    language?: string;
    diff?: boolean;
  } = $props();
  let html = $state<string[]>([]);
  let rows = $derived(
    diff
      ? diffRows(text)
      : text.split('\n').map((text) => ({
          text,
          kind: 'context',
          html: escapeText(text),
        })),
  );
  $effect(() => {
    const current = rows;
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
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex (正文滚动区需要支持键盘阅读。) -->
<div
  class="tool-code"
  role="region"
  aria-label={diff ? '代码差异' : '工具正文'}
  tabindex="0"
>
  <pre class="tool-code-lines"><code
      class={language ? `language-${language} hljs` : ''}
      >{#each rows as row, index}<span
          class="tool-code-line"
          class:diff-added={diff && row.kind === 'added'}
          class:diff-removed={diff && row.kind === 'removed'}
          class:diff-context={diff && row.kind === 'context'}
          >{@html html[index] ?? row.html}{row.text ? '' : '\u200b'}</span
        >{/each}</code
    ></pre>
</div>
