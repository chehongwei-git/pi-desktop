import { describe, expect, it } from 'vitest';
import { codeFileTarget, fileTarget } from './file-links';
import { markdown } from './markdown';
describe('对话文件入口', () => {
  it('解析中文编码、空格、平台路径与行号', () => {
    expect(fileTarget('docs/%E8%AF%B4%E6%98%8E%20a.pdf')).toEqual({
      path: 'docs/说明 a.pdf',
    });
    expect(fileTarget('src/main.ts:42:3')).toEqual({
      path: 'src/main.ts',
      line: 42,
    });
    expect(fileTarget('src/main.ts#L9-L12')).toEqual({
      path: 'src/main.ts',
      line: 9,
    });
    expect(fileTarget('file:///C:/work/a%20b.docx')).toEqual({
      path: 'C:/work/a b.docx',
    });
    expect(fileTarget('C:\\work\\说明.txt')).toEqual({
      path: 'C:\\work\\说明.txt',
    });
    expect(codeFileTarget('src/100%25.ts')).toEqual({ path: 'src/100%25.ts' });
  });
  it('拒绝危险协议、网络共享与歧义代码', () => {
    for (const path of [
      'javascript:alert(1)',
      'data:text/html,x',
      'pi://run',
      'file://server/a',
      '//server/a',
      '\\\\server\\a',
      'a%00.txt',
      'bad%ZZ',
    ])
      expect(fileTarget(path)).toBeNull();
    for (const path of [
      'npm run build',
      'foo.bar()',
      'a = b.ts',
      'hello',
      '<file.ts>',
    ])
      expect(codeFileTarget(path)).toBeNull();
  });
  it('代码样式链接标签保留外层完整目标，不产生嵌套链接', () => {
    const root = document.createElement('div');
    root.innerHTML = markdown('[`main.ts`](src/main.ts#L12)');
    expect(root.querySelectorAll('a')).toHaveLength(1);
    expect(root.querySelector('a')?.getAttribute('data-file-path')).toBe(
      'src/main.ts',
    );
    expect(root.querySelector('a')?.getAttribute('data-file-line')).toBe('12');
  });
  it('清洗后保留文件入口但不允许直接 file 导航或代码块链接', () => {
    const root = document.createElement('div');
    root.innerHTML = markdown(
      '[报告](file:///tmp/%E6%8A%A5%E5%91%8A.pdf)\n\n`src/main.ts:9`\n\n```ts\nsrc/main.ts\n```\n\n[x](javascript:alert(1))\n\n[网页](https://example.com)',
    );
    expect(
      root.querySelector('[data-file-path="/tmp/报告.pdf"]'),
    ).not.toBeNull();
    expect(root.querySelector('[data-file-line="9"]')).not.toBeNull();
    expect(root.querySelector('a[href^="file:"]')).toBeNull();
    expect(root.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(root.querySelector('pre a')).toBeNull();
    expect(root.querySelector('a[href="https://example.com"]')).not.toBeNull();
  });
});
