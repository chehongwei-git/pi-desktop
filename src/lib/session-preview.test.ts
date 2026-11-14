import { expect, it } from 'vitest';
import { sessionPreview } from './session-preview';
it('先提取任务再截断，跨平台路径和换行不进入摘要', () => {
  for (const newline of ['\n', '\r\n']) {
    for (const path of [
      '/skills/ego-browser/SKILL.md',
      'C:\\skills\\ego-browser\\SKILL.md',
    ]) {
      const skill = `<skill name="ego-browser" location="${path}">${newline}${'很长的指令'.repeat(500)}${newline}</skill>`;
      expect(
        sessionPreview(
          `${skill}${newline}${newline}帮我检查登录页面\n并修复问题`,
        ),
      ).toBe('帮我检查登录页面 并修复问题');
      expect(sessionPreview(skill)).toBe('使用 ego-browser');
    }
  }
});
it('保留普通文字和引用示例，Unicode 截断不拆分代理对', () => {
  expect(sessionPreview('  普通\n任务  ')).toBe('普通 任务');
  const example = '> <skill name="demo" location="/skills/SKILL.md">';
  expect(sessionPreview(example)).toBe(example);
  expect(sessionPreview('😀'.repeat(120))).toBe('😀'.repeat(100));
});
it('旧截断恢复摘要不展示机器路径', () => {
  expect(
    sessionPreview(
      '<skill name="ego-browser" location="/Users/example/.agents/skills/ego-browser/SKILL.m',
    ),
  ).toBe('使用 ego-browser');
});
