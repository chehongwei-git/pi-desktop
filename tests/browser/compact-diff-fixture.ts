/** 使用真实面板验证折叠和键盘行为，不模拟组件渲染。 */
import { mount } from 'svelte';
import ChangePanel from '../../src/lib/components/ChangePanel.svelte';
import '../../src/styles.css';
const context = (start: number, count: number) =>
  Array.from({ length: count }, (_, i) => ` ${start + i} keep-${start + i}`);
const text = [
  ...context(1, 60),
  '-61 old',
  '+61 new',
  ...context(62, 60),
  '-122 before',
  '+122 after',
  ...context(123, 60),
].join('\n');
mount(ChangePanel, {
  target: document.querySelector('main')!,
  props: {
    message: {
      id: 'diff',
      role: 'toolResult',
      status: 'done',
      text: '',
      thinking: '',
      contentRef: null,
      name: 'edit',
      tool: {
        callId: 'diff',
        name: 'edit',
        path: 'src/settings.ts',
        diffRef: 'diff',
        addedLines: 2,
        removedLines: 2,
      },
    },
    read: async () => ({ text, next: text.length, done: true }),
    onclose: () => {},
  },
});
