/** Markdown 输出是非可信输入；此测试验证真实 DOM 清洗与危险链接边界。 */
import { describe, it, expect } from 'vitest';
import { markdown, safeExternal } from './markdown';
describe('untrusted markdown', () => {
  it('never renders raw scripts or requests remote images', () => {
    const html = markdown(
      '<script>alert(1)</script>\n\n![tracking](https://example.com/pixel)',
    );
    const root = document.createElement('div');
    root.innerHTML = html;
    expect(root.querySelector('script,img,iframe')).toBeNull();
    expect(root.textContent).toContain('[图片未加载]');
  });
  it('rejects file/javascript/custom protocols while allowing http and https', () => {
    for (const url of [
      'javascript:alert(1)',
      'file:///secret',
      'pi://run',
      '/local',
    ])
      expect(safeExternal(url)).toBe(false);
    expect(safeExternal('https://example.com')).toBe(true);
  });
});
