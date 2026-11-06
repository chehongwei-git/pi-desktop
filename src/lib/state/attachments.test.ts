/** 文件引用参与所有发送与恢复路径；不访问网络或用户文件。 */
import { describe, expect, it, vi } from 'vitest';
import { Desktop } from './desktop.svelte';
import { bridge } from '../client';
import {
  composePrompt,
  imageAttachment,
  type PathAttachment,
} from '../attachments';
const reference = (
  id = 'file',
  path = '/tmp/需求 文件.pdf',
): PathAttachment => ({
  id,
  kind: 'path',
  path,
  name: '需求 文件.pdf',
  directory: false,
});
function setup(action = vi.fn().mockResolvedValue({})) {
  const desktop = new Desktop({ ...bridge, action });
  desktop.connection = 'ready';
  desktop.runtimeId = 'r';
  desktop.project = '/project';
  desktop.snapshot = {
    sessionFile: '/session',
    model: { id: 'm', provider: 'p', name: 'M', input: ['text', 'image'] },
  };
  return { desktop, action };
}
describe('file references', () => {
  it('sends a reference-only prompt through the existing text protocol', async () => {
    const { desktop, action } = setup();
    desktop.attachments = [reference()];
    const text = composePrompt(desktop.draftSnapshot()).text;
    await desktop.send();
    expect(action).toHaveBeenCalledWith('r', {
      type: 'prompt',
      message: text,
      mode: undefined,
      textParts: [
        {
          kind: 'files',
          id: 'file-references',
          start: 0,
          end: text.length,
          files: [{ id: 'file', path: '/tmp/需求 文件.pdf', directory: false }],
        },
      ],
    });
    expect(desktop.attachments).toEqual([]);
  });
  it('retains a failed mixed submission including paste cards without resending', async () => {
    const { desktop, action } = setup(
      vi.fn().mockRejectedValue(new Error('offline')),
    );
    desktop.draft = '原文';
    desktop.draftParts = [{ kind: 'paste', id: 'p', text: '原文' }];
    desktop.attachments = [
      reference(),
      imageAttachment({ id: 'hash', mimeType: 'image/png', data: 'aA==' }),
    ];
    const before = desktop.draftSnapshot();
    await expect(desktop.send()).rejects.toThrow('offline');
    expect(desktop.draftSnapshot()).toEqual(before);
    expect(action).toHaveBeenCalledOnce();
    expect(
      action.mock.calls[0][1].textParts.map(
        (part: { kind: string }) => part.kind,
      ),
    ).toEqual(['paste', 'files']);
  });
  it('clears only submitted instances, retaining a duplicate added during acceptance', async () => {
    let done!: (value: unknown) => void;
    const { desktop } = setup(
      vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            done = resolve;
          }),
      ),
    );
    desktop.draft = '检查';
    desktop.attachments = [reference()];
    const sending = desktop.send();
    desktop.draft = '下一条';
    desktop.attachments = [...desktop.attachments, reference('new')];
    done({});
    await sending;
    expect(desktop.draft).toBe('下一条');
    expect(desktop.attachments).toEqual([reference('new')]);
  });
  it.each(['steer', 'followUp'] as const)(
    'restores the original %s draft and references after queue cancellation',
    async (mode) => {
      const { desktop, action } = setup();
      desktop.run = 'running';
      desktop.draft = '检查';
      desktop.attachments = [reference()];
      const original = desktop.draftSnapshot();
      const wire = composePrompt(original).text;
      await desktop.send(mode);
      action.mockResolvedValue({
        steering: mode === 'steer' ? [wire] : [],
        followUp: mode === 'followUp' ? [wire] : [],
      });
      vi.spyOn(desktop, 'syncState').mockResolvedValue();
      await desktop.stop();
      desktop.draft = '保留';
      desktop.attachments = [reference('next', '/tmp/next.ts')];
      desktop.restoreDraft(0);
      expect(desktop.draftSnapshot()).toEqual(original);
      expect(desktop.recoveredDrafts[0].text).toBe('保留');
      expect(desktop.recoveredDrafts[0].attachments[0].id).toBe('next');
    },
  );
  it('isolates references across a local new chat and blocks commands without consuming them', async () => {
    const { desktop, action } = setup();
    desktop.attachments = [reference()];
    desktop.prepareNewChat();
    expect(desktop.attachments).toEqual([]);
    desktop.attachments = [reference('new')];
    await desktop.openSession('/project', '/session');
    expect(desktop.attachments).toEqual([reference()]);
    desktop.draft = '/compact';
    await expect(desktop.send()).rejects.toThrow('斜杠命令');
    expect(action).not.toHaveBeenCalled();
  });
});
