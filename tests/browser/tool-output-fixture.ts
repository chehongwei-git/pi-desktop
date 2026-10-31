/** 仅供浏览器测试挂载真实组件，经过 Vite 处理依赖。 */
import { mount } from 'svelte';
import ToolCode from '../../src/lib/components/ToolCode.svelte';
import '../../src/styles.css';

const target = document.querySelector('main')!;
for (const props of [
  { text: '  ' + '长路径/continuous-segment/'.repeat(35) + '\n下一行' },
  {
    text:
      Array.from(
        { length: 500 },
        (_, i) => i + ': ' + 'abcdef中文'.repeat(i % 4 ? 24 : 60),
      ).join('\n') + '\n最后一行',
  },
  {
    text: '-1 ' + 'oldValue'.repeat(60) + '\n+1 ' + 'newValue'.repeat(60),
    diff: true,
  },
]) {
  mount(ToolCode, { target, props });
}
