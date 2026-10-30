<!-- 本地图标组件：不依赖字体/CDN；语义由外层按钮的 aria-label 提供。 -->
<script lang="ts">
  /** name 选择静态 SVG 路径，size 为 CSS 像素；组件不接收任意 SVG 字符串。 */
  let { name, size = 20 }: { name: string; size?: number } = $props();
  const paths: Record<string, string> = {
    panel:
      'M9 3v18M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z',
    plus: 'M12 5v14M5 12h14',
    search: 'm21 21-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z',
    arrow: 'M12 19V5m-6 6 6-6 6 6',
    down: 'm6 9 6 6 6-6',
    close: 'm6 6 12 12M6 18 18 6',
    pin: 'M9 3h6l-1 6 4 4v2H6v-2l4-4-1-6ZM12 15v7',
    folder: 'M3 7V5h6l2 2h10v13H3V7Z',
    settings:
      'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2',
    copy: 'M9 9h12v12H9V9ZM15 5V3H3v12h2',
    check: 'm5 12 4 4L19 6',
    more: 'M5 12h.01M12 12h.01M19 12h.01',
    stop: 'M6 6h12v12H6z',
    refresh:
      'M20 7v5h-5M4 17v-5h5M5.5 7a7 7 0 0 1 12-2l2.5 7M4 12l2.5 7a7 7 0 0 0 12-2',
    chat: 'M21 11a9 9 0 0 1-9 9H7l-5 2 2-5V11a9 9 0 0 1 17 0Z',
    pi: 'M4 7h16M8 7v12M16 7v9q0 3 3 3',
  };
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="1.7"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"><path d={paths[name] ?? paths.chat} /></svg
>
