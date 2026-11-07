import { diffRows, type DiffRow } from './tool-presentation';

export type DiffSection = {
  start: number;
  rows: DiffRow[];
  folded: boolean;
  change: boolean;
};

/** 只折叠格式明确的上下文；文件头、分块头、缺失换行提示和未知正文始终保留。 */
export function compactDiff(text: string): {
  sections: DiffSection[];
  changes: number[];
  recognized: boolean;
} {
  const rows = diffRows(text.replace(/\r\n/g, '\n'));
  // split 产生的末尾空项不是一行源代码。
  if (text.endsWith('\n')) rows.pop();
  const context = (row: DiffRow) => row.text.startsWith(' ');
  const recognized = rows.every(
    (row) =>
      row.kind !== 'context' ||
      context(row) ||
      /^(?:diff |index |--- |\+\+\+ |@@|\\ No newline|! 完整替换)/.test(
        row.text,
      ),
  );
  const changes: number[] = [];
  const visible = new Uint8Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].kind === 'context') {
      if (!context(rows[i])) visible[i] = 1;
      continue;
    }
    if (i === 0 || rows[i - 1].kind === 'context') changes.push(i);
    visible[i] = 1;
    // 上下文只跨越真实未修改行，不跨文件头和 hunk 边界。
    for (const direction of [-1, 1]) {
      let at = i + direction;
      let count = 0;
      while (at >= 0 && at < rows.length && count < 3 && context(rows[at])) {
        visible[at] = 1;
        count++;
        at += direction;
      }
    }
  }
  const sections: DiffSection[] = [];
  const starts = new Set(changes);
  for (let i = 0; i < rows.length; i++) {
    const folded = recognized && changes.length > 0 && !visible[i];
    const previous = sections.at(-1);
    if (previous && previous.folded === folded && !starts.has(i))
      previous.rows.push(rows[i]);
    else
      sections.push({
        start: i,
        rows: [rows[i]],
        folded,
        change: starts.has(i),
      });
  }
  return { sections, changes, recognized };
}
