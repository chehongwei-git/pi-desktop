/** 图片发送覆盖失败保留、草稿隔离与停止恢复，不调用模型网络。 */
import { describe, expect, it, vi } from 'vitest';
import { Desktop } from './desktop.svelte';
import { bridge } from '../client';
const image = {
  id: 'hash',
  mimeType: 'image/png',
  data: 'aGVsbG8=',
  name: '截图.png',
};
function setup(action = vi.fn().mockResolvedValue({})) {
  const desktop = new Desktop({ ...bridge, action });
  desktop.connection = 'ready';
  desktop.runtimeId = 'r';
  desktop.project = 'project';
  desktop.snapshot = {
    sessionFile: 'session',
    model: { id: 'm', name: 'M', provider: 'p', input: ['text', 'image'] },
  };
  desktop.images = [image];
  return { desktop, action };
}
describe('image messages', () => {
  it('sends image-only prompts and clears only submitted images', async () => {
    const { desktop, action } = setup();
    await desktop.send();
    expect(action).toHaveBeenCalledWith('r', {
      type: 'prompt',
      message: '',
      mode: undefined,
      images: [{ type: 'image', data: image.data, mimeType: image.mimeType }],
    });
    expect(desktop.images).toEqual([]);
  });
  it('carries images into the first real session and retains them if that prompt fails', async () => {
    const { desktop, action } = setup(
      vi.fn().mockRejectedValue(new Error('prompt failed')),
    );
    desktop.prepareNewChat();
    desktop.images = [image];
    vi.spyOn(desktop, 'newSession').mockImplementation(async () => {
      desktop.newChatProject = null;
      desktop.snapshot = { ...desktop.snapshot, sessionFile: 'created' };
      desktop.images = [];
    });
    await expect(desktop.send()).rejects.toThrow('prompt failed');
    expect(desktop.images).toEqual([image]);
    expect(desktop.snapshot.sessionFile).toBe('created');
    expect(action).toHaveBeenCalledOnce();
  });
  it('preserves edits made while a prompt is awaiting acceptance', async () => {
    let accept!: (value: unknown) => void;
    const { desktop } = setup(
      vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            accept = resolve;
          }),
      ),
    );
    desktop.draft = '原消息';
    const sending = desktop.send();
    desktop.draft = '下一条';
    desktop.images = [...desktop.images, { ...image, id: 'another' }];
    accept({});
    await sending;
    expect(desktop.draft).toBe('下一条');
    expect(desktop.images.map((image) => image.id)).toEqual(['another']);
  });
  it('retains text and images after a rejected submission without retry', async () => {
    const { desktop, action } = setup(
      vi.fn().mockRejectedValue(new Error('timeout')),
    );
    desktop.draft = '分析截图';
    await expect(desktop.send()).rejects.toThrow('timeout');
    expect(desktop.images).toEqual([image]);
    expect(desktop.draft).toBe('分析截图');
    expect(action).toHaveBeenCalledOnce();
  });
  it('blocks text-only models and slash commands without losing images', async () => {
    const { desktop, action } = setup();
    desktop.snapshot.model!.input = ['text'];
    await expect(desktop.send()).rejects.toThrow('不支持图片');
    desktop.draft = '/compact';
    await expect(desktop.send()).rejects.toThrow('斜杠命令');
    expect(action).not.toHaveBeenCalled();
    expect(desktop.images).toHaveLength(1);
  });
  it('keeps image drafts separate when returning from a new chat', async () => {
    const { desktop } = setup();
    desktop.prepareNewChat();
    expect(desktop.images).toEqual([]);
    desktop.images = [{ ...image, id: 'new' }];
    await desktop.openSession('project', 'session');
    expect(desktop.images[0].id).toBe('hash');
    desktop.prepareNewChat();
    expect(desktop.images[0].id).toBe('new');
  });
  it('restores images from cleared queued messages and exchanges the current draft', async () => {
    const { desktop, action } = setup(
      vi.fn().mockResolvedValue({ steering: [''], followUp: [] }),
    );
    desktop.run = 'running';
    await desktop.send();
    vi.spyOn(desktop, 'syncState').mockResolvedValue();
    await desktop.stop();
    expect(desktop.recoveredImages).toHaveLength(1);
    desktop.draft = '正在编辑';
    desktop.restoreImages(0);
    expect(desktop.images).toEqual([image]);
    expect(desktop.draft).toBe('');
    expect(desktop.recoveredImages[0].text).toBe('正在编辑');
    expect(
      action.mock.calls.filter(([, command]) => command.type === 'prompt'),
    ).toHaveLength(1);
  });
});
