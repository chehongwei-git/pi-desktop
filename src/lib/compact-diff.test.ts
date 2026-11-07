import { describe, expect, it } from 'vitest';
import { compactDiff } from './compact-diff';

const context = (start: number, count: number) =>
  Array.from({ length: count }, (_, i) => ` ${start + i} keep-${start + i}`);
describe('精简差异', () => {
  it('保留前后各三行并合并重叠上下文', () => {
    const model = compactDiff(
      [
        ...context(1, 10),
        '-11 old',
        '+11 new',
        ...context(12, 5),
        '+17 added',
        ...context(18, 10),
      ].join('\r\n'),
    );
    expect(model.recognized).toBe(true);
    expect(model.changes).toHaveLength(2);
    expect(
      model.sections.filter((s) => s.folded).map((s) => s.rows.length),
    ).toEqual([7, 7]);
    const visible = model.sections
      .filter((s) => !s.folded)
      .flatMap((s) => s.rows);
    expect(visible[0].text).toBe(' 8 keep-8');
    expect(visible.at(-1)?.text).toBe(' 20 keep-20');
    expect(visible.filter((r) => r.text === ' 14 keep-14')).toHaveLength(1);
  });
  it('保留文件头、分块头和缺失换行提示，不虚构省略行', () => {
    const text =
      '--- a/file\n+++ b/file\n@@ -10,2 +10,2 @@\n- old\n+ new\n\\ No newline at end of file\n';
    const model = compactDiff(text);
    expect(model.recognized).toBe(true);
    expect(
      model.sections
        .flatMap((s) => s.rows)
        .map((r) => r.text)
        .join('\n'),
    ).toBe(text.trimEnd());
    expect(model.sections.some((s) => s.folded)).toBe(false);
  });
  it('新增、删除、未知格式和二进制正文不隐藏真实内容', () => {
    for (const text of [
      '+1 new\n+2 more',
      '-1 old',
      '二进制文件内容已变化',
      '-1 old\ncustom\n+1 new',
      '',
      ' partial',
    ]) {
      const model = compactDiff(text);
      expect(model.sections.some((s) => s.folded)).toBe(false);
    }
    expect(compactDiff('-1 old\ncustom\n+1 new').recognized).toBe(false);
  });
  it('完整替换提示保持可见，首尾修改及跨页续接不丢行', () => {
    const text = [
      '! 完整替换：预算限制',
      '-1 old',
      '+1 new',
      ...context(2, 20),
      '+22 last',
    ].join('\n');
    const model = compactDiff(text);
    expect(model.sections[0].rows[0].text).toContain('完整替换');
    expect(
      model.sections
        .flatMap((s) => s.rows)
        .map((r) => r.text)
        .join('\n'),
    ).toBe(text);
    const chunks = [text.slice(0, 17), text.slice(17, 25), text.slice(25)];
    expect(compactDiff(chunks.join(''))).toEqual(model);
  });
});
