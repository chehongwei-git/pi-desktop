import { expect, it, vi } from 'vitest';
import { Desktop } from './desktop.svelte';
import { bridge } from '../client';

it.each(['project', 'session'] as const)(
  'archives, restores and undoes %s metadata after a native JSON round trip with null fields',
  async (kind) => {
    const save = vi.fn().mockResolvedValue(undefined);
    const desktop = new Desktop({ ...bridge, save });
    desktop.settings.sidebarItems = [
      { kind, path: '/work/item', name: null, state: null },
    ];
    desktop.draft = '保留草稿';
    await desktop.manageSidebar(kind, '/work/item', { state: 'archived' });
    expect(desktop.archivedItems).toHaveLength(1);
    expect(desktop.sidebarFeedback).toContain('已归档');
    await desktop.undoSidebar();
    expect(desktop.archivedItems).toHaveLength(0);
    await desktop.manageSidebar(kind, '/work/item', { state: 'archived' });
    await desktop.manageSidebar(kind, '/work/item', { state: undefined });
    expect(desktop.archivedItems).toHaveLength(0);
    expect(desktop.sidebarSaving).toBe(false);
    expect(desktop.draft).toBe('保留草稿');
    expect(save).toHaveBeenCalledTimes(4);
    await desktop.manageSidebar(kind, '/work/item', { name: ' 新名称 ' });
    expect(desktop.sidebarItem(kind, '/work/item')?.name).toBe('新名称');
    await expect(
      desktop.manageSidebar(kind, '/work/item', { name: ' ' }),
    ).rejects.toThrow('名称须为');
  },
);
