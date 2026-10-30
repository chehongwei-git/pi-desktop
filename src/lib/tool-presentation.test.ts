import { describe, expect, it } from 'vitest';
import {
  colorCode,
  diffRows,
  languageForPath,
  toolPreview,
} from './tool-presentation';
import type { Message } from './types';
const message = (
  name: string,
  text: string,
  tool: Message['tool'] = undefined,
): Message => ({
  id: 't',
  role: 'toolResult',
  text,
  thinking: '',
  name,
  status: 'done',
  contentRef: null,
  tool,
});
describe('tool presentation', () => {
  it('uses shell tails, hides reads, and preserves unknown-tool output', () => {
    const text = Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n');
    expect(toolPreview(message('bash', text)).text).toBe(
      text.split('\n').slice(-5).join('\n'),
    );
    expect(toolPreview(message('read', text)).text).toBe('');
    expect(toolPreview(message('custom', text)).text).toBe(
      text.split('\n').slice(0, 5).join('\n'),
    );
    expect(
      toolPreview(
        message('bash', text, {
          callId: 't',
          name: 'bash',
          tail: 'real tail',
          outputLines: 100,
        }),
      ).hidden,
    ).toBe(99);
    expect(
      toolPreview({ ...message('read', '错误'), status: 'error' }).text,
    ).toBe('错误');
  });
  it('marks additions, deletions and changed words without interpreting HTML', () => {
    const rows = diffRows(
      ' 1 keep\n-2 const x = "old";\n+2 const x = "new";\n+3 <script>alert(1)</script>',
    );
    expect(rows[1].kind).toBe('removed');
    // 多行新增组不进行误导性的逐行配对。
    expect(rows[1].html).not.toContain('<mark>');
    const pair = diffRows('-2 const x = "old";\n+2 const x = "new";');
    expect(pair[0].html).toContain('<mark>old</mark>');
    expect(pair[1].html).toContain('<mark>new</mark>');
    expect(rows[3].html).toContain('&lt;script&gt;');
    expect(
      diffRows('--- a/file\n+++ b/file').every((row) => row.kind === 'context'),
    ).toBe(true);
  });
  it('highlights known languages and safely falls back for unknown or oversized text', async () => {
    expect(languageForPath('C:\\work\\Main.JAVA')).toBe('java');
    expect(languageForPath('file.unknown')).toBeUndefined();
    expect(
      await colorCode('const answer: number = 42;', 'typescript'),
    ).toContain('hljs-keyword');
    expect(await colorCode('<script>alert(1)</script>', 'unknown')).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;',
    );
    expect(await colorCode('<'.repeat(110000), 'typescript')).not.toContain(
      '<span',
    );
  });
});
