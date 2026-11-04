import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import Composer from './Composer.svelte';
afterEach(cleanup);

it('keeps short pastes ordinary, folds long plain text and ignores HTML', async () => {
  const view = render(Composer, { onsend: vi.fn(), onstop: vi.fn() });
  const input = view.getByRole('textbox');
  await fireEvent.paste(input, {
    clipboardData: {
      files: [],
      getData: (type: string) =>
        type === 'text/plain' ? 'short' : '<img onerror="alert(1)">',
    },
  });
  expect(input).toHaveValue('short');
  (input as HTMLTextAreaElement).setSelectionRange(0, 5);
  await fireEvent.paste(input, {
    clipboardData: { files: [], getData: () => '中文'.repeat(600) },
  });
  expect(
    view.getByRole('button', { name: /还原粘贴文本/ }),
  ).toBeInTheDocument();
  expect(view.getByRole('button', { name: '发送消息' })).toBeEnabled();
  expect(view.container.querySelector('img')).toBeNull();
});

it('retains cards through IME confirmation and blocks disabled paste', async () => {
  const onsend = vi.fn();
  const text = '段落\n'.repeat(12);
  const view = render(Composer, {
    value: text,
    parts: [{ kind: 'paste', id: 'a', text }],
    onsend,
    onstop: vi.fn(),
  });
  await view.findByRole('button', { name: /还原粘贴文本/ });
  const input = view.getByRole('textbox');
  await fireEvent.compositionStart(input);
  await fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
  expect(onsend).not.toHaveBeenCalled();
  await fireEvent.compositionEnd(input);
  await fireEvent.keyDown(input, { key: 'Enter' });
  expect(onsend).toHaveBeenCalledOnce();
  await view.rerender({ disabled: true });
  await fireEvent.paste(input, {
    clipboardData: { files: [], getData: () => text },
  });
  expect(view.getAllByRole('button', { name: /还原粘贴文本/ })).toHaveLength(1);
  expect(view.getByRole('button', { name: /还原粘贴文本/ })).toBeDisabled();
});
