/** 三种附件入口共享真实文件读取；摘要用稳定边界替身。 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Composer from './Composer.svelte';
const native = vi.hoisted(() => ({ enabled: false, invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', async (original) => ({
  ...(await original<object>()),
  isTauri: () => native.enabled,
  invoke: native.invoke,
}));
afterEach(() => {
  cleanup();
  native.enabled = false;
  native.invoke.mockReset();
  vi.unstubAllGlobals();
});
describe('image composer', () => {
  it('uses the native picker, prevents duplicate selection and ignores late results', async () => {
    native.enabled = true;
    let resolve!: (images: unknown[]) => void;
    native.invoke.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const view = render(Composer, {
      historyKey: 'first',
      onsend: vi.fn(),
      onstop: vi.fn(),
    });
    const button = view.getByRole('button', { name: '添加图片' });
    const htmlPicker = vi.spyOn(view.getByLabelText('选择图片文件'), 'click');
    await fireEvent.click(button);
    expect(native.invoke).toHaveBeenCalledWith('pick_images');
    expect(button).toBeDisabled();
    expect(htmlPicker).not.toHaveBeenCalled();
    await view.rerender({ historyKey: 'second' });
    resolve([
      { id: 'old', name: 'old.png', mimeType: 'image/png', data: 'aA==' },
    ]);
    await waitFor(() => expect(button).toBeEnabled());
    expect(view.queryByAltText('old.png')).not.toBeInTheDocument();
  });
  it('preserves text on native cancellation and reports read failures inline', async () => {
    native.enabled = true;
    native.invoke
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('图片读取失败'));
    const view = render(Composer, {
      value: '保留草稿',
      onsend: vi.fn(),
      onstop: vi.fn(),
    });
    const button = view.getByRole('button', { name: '添加图片' });
    await fireEvent.click(button);
    await waitFor(() => expect(button).toBeEnabled());
    expect(view.queryByRole('alert')).not.toBeInTheDocument();
    await fireEvent.click(button);
    await waitFor(() =>
      expect(view.getByRole('alert')).toHaveTextContent('图片读取失败'),
    );
    expect(view.getByRole('textbox')).toHaveValue('保留草稿');
  });
  it.each(['choose', 'paste', 'drop'])(
    'adds and removes an image through %s and allows an image-only send',
    async (method) => {
      vi.stubGlobal('crypto', {
        subtle: { digest: async () => new Uint8Array([1, 2]).buffer },
      });
      const onsend = vi.fn();
      const view = render(Composer, { onsend, onstop: vi.fn() });
      const imageButton = view.getByRole('button', { name: '添加图片' });
      expect(imageButton.textContent?.trim()).toBe('');
      expect(imageButton.querySelector('svg')).toBeInTheDocument();
      const picker = view.getByLabelText('选择图片文件');
      expect(picker).toHaveAttribute(
        'accept',
        'image/png,image/jpeg,image/webp,image/gif,.png,.jpg,.jpeg,.webp,.gif',
      );
      const choose = vi.spyOn(picker, 'click');
      await fireEvent.click(imageButton);
      expect(choose).toHaveBeenCalledOnce();
      const file = new File(['png'], '截图.png', { type: 'image/png' });
      if (method === 'choose')
        await fireEvent.change(view.getByLabelText('选择图片文件'), {
          target: { files: [file] },
        });
      if (method === 'paste')
        await fireEvent.paste(view.getByRole('textbox'), {
          clipboardData: { files: [file] },
        });
      if (method === 'drop')
        await fireEvent.drop(view.getByRole('group', { name: '消息编辑器' }), {
          dataTransfer: { files: [file] },
        });
      await waitFor(() =>
        expect(view.getByAltText('截图.png')).toBeInTheDocument(),
      );
      await fireEvent.keyDown(view.getByRole('textbox'), { key: 'Enter' });
      expect(onsend).toHaveBeenCalledOnce();
      await fireEvent.click(view.getByRole('button', { name: '移除截图.png' }));
      expect(view.getByRole('button', { name: '发送消息' })).toBeDisabled();
    },
  );
  it('ignores a completed image read after switching context', async () => {
    let resolve!: (value: ArrayBuffer) => void;
    vi.stubGlobal('crypto', {
      subtle: {
        digest: () =>
          new Promise<ArrayBuffer>((done) => {
            resolve = done;
          }),
      },
    });
    const view = render(Composer, {
      historyKey: 'first',
      onsend: vi.fn(),
      onstop: vi.fn(),
    });
    await fireEvent.change(view.getByLabelText('选择图片文件'), {
      target: { files: [new File(['png'], 'old.png', { type: 'image/png' })] },
    });
    await waitFor(() => expect(resolve).toBeDefined());
    await view.rerender({ historyKey: 'second' });
    resolve(new Uint8Array([1]).buffer);
    await waitFor(() =>
      expect(view.queryByRole('status')).not.toBeInTheDocument(),
    );
    expect(view.queryByAltText('old.png')).not.toBeInTheDocument();
  });
  it('rejects unsupported files inline without submitting', async () => {
    const onsend = vi.fn();
    const view = render(Composer, { onsend, onstop: vi.fn() });
    await fireEvent.change(view.getByLabelText('选择图片文件'), {
      target: {
        files: [new File(['svg'], 'test.svg', { type: 'image/svg+xml' })],
      },
    });
    expect(view.getByRole('alert')).toHaveTextContent('支持 PNG');
    expect(onsend).not.toHaveBeenCalled();
  });
});
