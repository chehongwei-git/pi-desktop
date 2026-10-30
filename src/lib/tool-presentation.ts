/** 工具展示纯函数：未知格式保留原文，绝不把结果当 Markdown 或可信 HTML。 */
import DOMPurify from 'dompurify';
import type { Message } from './types';
export function escapeText(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!,
  );
}
const languages = {
  javascript: () => import('highlight.js/lib/languages/javascript'),
  typescript: () => import('highlight.js/lib/languages/typescript'),
  json: () => import('highlight.js/lib/languages/json'),
  bash: () => import('highlight.js/lib/languages/bash'),
  powershell: () => import('highlight.js/lib/languages/powershell'),
  python: () => import('highlight.js/lib/languages/python'),
  rust: () => import('highlight.js/lib/languages/rust'),
  css: () => import('highlight.js/lib/languages/css'),
  xml: () => import('highlight.js/lib/languages/xml'),
  java: () => import('highlight.js/lib/languages/java'),
  sql: () => import('highlight.js/lib/languages/sql'),
  yaml: () => import('highlight.js/lib/languages/yaml'),
  go: () => import('highlight.js/lib/languages/go'),
  c: () => import('highlight.js/lib/languages/c'),
  cpp: () => import('highlight.js/lib/languages/cpp'),
  diff: () => import('highlight.js/lib/languages/diff'),
};
const loaded = new Map<string, Promise<void>>();
export function languageForPath(path = ''): string | undefined {
  const extension = path.toLowerCase().split('.').at(-1) ?? '';
  return (
    {
      js: 'javascript',
      mjs: 'javascript',
      cjs: 'javascript',
      jsx: 'javascript',
      ts: 'typescript',
      tsx: 'typescript',
      svelte: 'xml',
      vue: 'xml',
      html: 'xml',
      xml: 'xml',
      json: 'json',
      jsonl: 'json',
      sh: 'bash',
      bash: 'bash',
      ps1: 'powershell',
      py: 'python',
      rs: 'rust',
      css: 'css',
      java: 'java',
      sql: 'sql',
      yaml: 'yaml',
      yml: 'yaml',
      go: 'go',
      c: 'c',
      h: 'c',
      cpp: 'cpp',
      cc: 'cpp',
      hpp: 'cpp',
      patch: 'diff',
      diff: 'diff',
    } as Record<string, string>
  )[extension];
}
export async function colorCode(
  text: string,
  language?: string,
): Promise<string> {
  if (!language || !(language in languages) || text.length > 100 * 1024)
    return escapeText(text);
  const { default: hljs } = await import('highlight.js/lib/core');
  if (!loaded.has(language))
    loaded.set(
      language,
      (async () => {
        const module = await languages[language as keyof typeof languages]();
        hljs.registerLanguage(language, module.default);
      })(),
    );
  await loaded.get(language);
  return DOMPurify.sanitize(
    hljs.highlight(text, { language, ignoreIllegals: true }).value,
    { ALLOWED_TAGS: ['span'], ALLOWED_ATTR: ['class'] },
  );
}
export function toolPreview(message: Message): {
  text: string;
  hidden: number;
  diff: boolean;
} {
  const tool = message.tool;
  const name = tool?.name ?? message.name ?? '';
  if (name === 'read' && message.status !== 'error')
    return {
      text: '',
      hidden:
        tool?.outputLines ??
        (message.text ? message.text.split('\n').length : 0),
      diff: false,
    };
  const diff = name === 'edit' && !!tool?.diffRef && message.status !== 'error';
  const text = diff
    ? (tool?.diffPreview ?? '')
    : ['bash', 'powershell'].includes(name)
      ? (tool?.tail ?? message.text.split('\n').slice(-5).join('\n'))
      : message.text.split('\n').slice(0, 5).join('\n');
  return {
    text,
    hidden: Math.max(
      0,
      ((diff ? tool?.diffLines : tool?.outputLines) ??
        (message.text ? message.text.split('\n').length : 0)) -
        (text ? text.split('\n').length : 0),
    ),
    diff,
  };
}
export type DiffRow = {
  text: string;
  kind: 'added' | 'removed' | 'context';
  html: string;
};
/** Pi diff 有行号，统一 diff 可能没有；两者保留原始行号和符号。 */
export function diffRows(text: string): DiffRow[] {
  const rows: DiffRow[] = text.split('\n').map((text) => ({
    text,
    kind:
      text.startsWith('+') && !text.startsWith('+++')
        ? 'added'
        : text.startsWith('-') && !text.startsWith('---')
          ? 'removed'
          : 'context',
    html: escapeText(text),
  }));
  for (let i = 0; i < rows.length - 1; i++) {
    const a = rows[i],
      b = rows[i + 1];
    if (
      a.kind !== 'removed' ||
      b.kind !== 'added' ||
      rows[i - 1]?.kind === 'removed' ||
      rows[i + 2]?.kind === 'added'
    )
      continue;
    const split = (line: string) => {
      const match = line.match(/^([+-](?:\s*\d+\s)?)(.*)$/);
      return match ? [match[1], match[2]] : ['', line];
    };
    const [ap, av] = split(a.text),
      [bp, bv] = split(b.text);
    const aw = av.match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) ?? [];
    const bw = bv.match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) ?? [];
    let start = 0,
      end = 0;
    while (start < Math.min(aw.length, bw.length) && aw[start] === bw[start])
      start++;
    while (
      end < Math.min(aw.length, bw.length) - start &&
      aw[aw.length - end - 1] === bw[bw.length - end - 1]
    )
      end++;
    const render = (prefix: string, words: string[]) =>
      escapeText(prefix + words.slice(0, start).join('')) +
      '<mark>' +
      escapeText(words.slice(start, words.length - end).join('')) +
      '</mark>' +
      escapeText(end ? words.slice(-end).join('') : '');
    if (av !== bv) {
      a.html = render(ap, aw);
      b.html = render(bp, bw);
    }
  }
  return rows;
}
