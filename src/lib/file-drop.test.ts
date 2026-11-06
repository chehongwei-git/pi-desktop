/** 原生事件注册与几何路由，模拟多会话、缩放和监听异步完成。 */
import { afterEach, expect, it, vi } from 'vitest';
const host = vi.hoisted(() => ({
  hover: undefined as ((event: any) => void) | undefined,
  drop: undefined as ((event: any) => void) | undefined,
  stopHover: vi.fn(),
  stopDrop: vi.fn(),
  listens: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true }));
vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: async (handler: (event: any) => void) => {
      host.hover = handler;
      return host.stopHover;
    },
  }),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (_name: string, handler: (event: any) => void) => {
    host.listens();
    host.drop = handler;
    return host.stopDrop;
  },
}));
import { containsDrop, registerFileDrop } from './file-drop';
const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  host.drop = undefined;
  host.hover = undefined;
});
function element(visible = true) {
  const node = document.createElement('div');
  document.body.append(node);
  const rect = {
    x: 100,
    y: 200,
    left: 100,
    top: 200,
    right: 500,
    bottom: 400,
    width: 400,
    height: 200,
    toJSON: () => ({}),
  };
  vi.spyOn(node, 'getBoundingClientRect').mockReturnValue(rect);
  vi.spyOn(node, 'getClientRects').mockReturnValue(
    (visible ? [rect] : []) as unknown as DOMRectList,
  );
  return node;
}
it('converts physical coordinates once and rejects hidden and disconnected inputs', () => {
  const node = element();
  expect(containsDrop(node, { x: 250, y: 450 }, 2)).toBe(true);
  expect(containsDrop(node, { x: 1000, y: 450 }, 2)).toBe(false);
  expect(containsDrop(element(false), { x: 250, y: 450 }, 2)).toBe(false);
  node.remove();
  expect(containsDrop(node, { x: 250, y: 450 }, 2)).toBe(false);
});
it('uses one native subscription and routes only to the visible enabled input', async () => {
  vi.spyOn(window, 'devicePixelRatio', 'get').mockReturnValue(2);
  const visible = {
    element: element(),
    enabled: () => true,
    hover: vi.fn(),
    drop: vi.fn(),
    error: vi.fn(),
  };
  const hidden = { ...visible, element: element(false), drop: vi.fn() };
  cleanups.push(registerFileDrop(visible), registerFileDrop(hidden));
  await vi.waitFor(() => expect(host.drop).toBeDefined());
  expect(host.listens).toHaveBeenCalledOnce();
  host.hover!({ payload: { type: 'over', position: { x: 250, y: 450 } } });
  expect(visible.hover).toHaveBeenLastCalledWith(true);
  host.drop!({ payload: { dropId: 'first', position: { x: 250, y: 450 } } });
  expect(visible.drop).toHaveBeenCalledWith('first');
  expect(hidden.drop).not.toHaveBeenCalled();
  visible.enabled = () => false;
  host.drop!({ payload: { dropId: 'blocked', position: { x: 250, y: 450 } } });
  expect(visible.drop).toHaveBeenCalledOnce();
  cleanups.splice(0).forEach((cleanup) => cleanup());
  expect(host.stopHover).toHaveBeenCalledOnce();
  expect(host.stopDrop).toHaveBeenCalledOnce();
});
it('removes listeners that finish registering after the component is gone', async () => {
  const dispose = registerFileDrop({
    element: element(),
    enabled: () => true,
    hover: vi.fn(),
    drop: vi.fn(),
    error: vi.fn(),
  });
  dispose();
  await vi.waitFor(() => expect(host.stopDrop).toHaveBeenCalledOnce());
  expect(host.stopHover).toHaveBeenCalledOnce();
});
