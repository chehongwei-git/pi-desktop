/** 安全 Markdown 渲染端口：拒绝原始 HTML、远程图片与危险协议；缓存限制在 8MiB。 */
import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';
const parser = new MarkdownIt({ html: false, linkify: false, breaks: true });
// 不给模型输出发起图片网络请求的机会，避免用户打开历史就泄露网络元数据。
parser.renderer.rules.image = () =>
  '<span class="image-placeholder">[图片未加载]</span>';
const cache = new Map<string, string>();
let bytes = 0;
/** 完成块渲染缓存采用 LRU；流式消息由组件直接输出纯文本。 */
export function markdown(text: string): string {
  const hit = cache.get(text);
  if (hit !== undefined) {
    cache.delete(text);
    cache.set(text, hit);
    return hit;
  }
  const html = DOMPurify.sanitize(parser.render(text), {
    FORBID_TAGS: ['img', 'iframe', 'style', 'script', 'form'],
    FORBID_ATTR: ['style'],
    ALLOW_DATA_ATTR: false,
  });
  if (text.length + html.length < 1024 * 1024) {
    cache.set(text, html);
    bytes += (text.length + html.length) * 2;
    while (bytes > 8 * 1024 * 1024) {
      const first = cache.keys().next().value;
      if (first === undefined) break;
      bytes -= (first.length + (cache.get(first)?.length ?? 0)) * 2;
      cache.delete(first);
    }
  }
  return html;
}
/** 只给系统浏览器放行 http/https；禁止相对路径、javascript、file 与自定义协议。 */
export function safeExternal(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}
/** 高亮只在代码块完成且低于 100KiB 时异步加载；卸载后不再操作 DOM。 */
export async function highlight(
  root: HTMLElement,
  alive: () => boolean,
): Promise<void> {
  const blocks = [...root.querySelectorAll<HTMLElement>('pre code')].filter(
    (block) => (block.textContent?.length ?? 0) < 100 * 1024,
  );
  if (!blocks.length) return;
  const { default: hljs } = await import('highlight.js/lib/core');
  const languages = await Promise.all([
    import('highlight.js/lib/languages/javascript'),
    import('highlight.js/lib/languages/typescript'),
    import('highlight.js/lib/languages/json'),
    import('highlight.js/lib/languages/bash'),
    import('highlight.js/lib/languages/python'),
    import('highlight.js/lib/languages/rust'),
    import('highlight.js/lib/languages/css'),
    import('highlight.js/lib/languages/xml'),
  ]);
  [
    'javascript',
    'typescript',
    'json',
    'bash',
    'python',
    'rust',
    'css',
    'xml',
  ].forEach((name, index) =>
    hljs.registerLanguage(name, languages[index].default),
  );
  if (!alive()) return;
  for (const block of blocks) {
    const language = [...block.classList]
      .find((name) => name.startsWith('language-'))
      ?.slice(9);
    if (language && hljs.getLanguage(language)) hljs.highlightElement(block);
  }
}
