/** 原生文件拖放只分发给当前可见的输入框，隐藏会话不各自监听窗口事件。 */
import { isTauri } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';

type Point = { x: number; y: number };
type Target = {
  element: HTMLElement;
  enabled: () => boolean;
  hover: (active: boolean) => void;
  drop: (id: string) => void;
  error: (message: string) => void;
};
const targets = new Set<Target>();
let subscription: { cancelled: boolean; listeners: UnlistenFn[] } | undefined;
/** 原生坐标为 WebView 物理像素；DPR 包含 Chromium 的页面缩放，不能再重复除以应用缩放。 */
export function containsDrop(
  element: HTMLElement,
  position: Point,
  ratio = window.devicePixelRatio || 1,
): boolean {
  if (!element.isConnected || !element.getClientRects().length) return false;
  const rect = element.getBoundingClientRect();
  const x = position.x / ratio;
  const y = position.y / ratio;
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    x >= rect.left &&
    x < rect.right &&
    y >= rect.top &&
    y < rect.bottom
  );
}
function targetAt(position: Point): Target | undefined {
  return [...targets]
    .reverse()
    .find(
      (target) => target.enabled() && containsDrop(target.element, position),
    );
}
function clearHover(): void {
  for (const target of targets) target.hover(false);
}
async function start(): Promise<void> {
  if (subscription || !isTauri()) return;
  const current = { cancelled: false, listeners: [] as UnlistenFn[] };
  subscription = current;
  const add = (listener: UnlistenFn) => {
    if (current.cancelled) listener();
    else current.listeners.push(listener);
  };
  try {
    add(
      await getCurrentWebview().onDragDropEvent((event) => {
        if (current.cancelled) return;
        clearHover();
        if (event.payload.type === 'enter' || event.payload.type === 'over')
          targetAt(event.payload.position)?.hover(true);
      }),
    );
    add(
      await listen<{ dropId: string; position: Point }>(
        'desktop-file-drop',
        ({ payload }) => {
          if (current.cancelled) return;
          clearHover();
          targetAt(payload.position)?.drop(payload.dropId);
        },
      ),
    );
  } catch {
    if (current.cancelled) return;
    for (const target of targets)
      target.error('文件拖入暂不可用，请使用“添加文件”。');
    for (const listener of current.listeners) listener();
    current.listeners = [];
    current.cancelled = true;
    if (subscription === current) subscription = undefined;
  }
}
export function registerFileDrop(target: Target): () => void {
  targets.add(target);
  void start();
  return () => {
    target.hover(false);
    targets.delete(target);
    if (!targets.size && subscription) {
      subscription.cancelled = true;
      for (const listener of subscription.listeners) listener();
      subscription = undefined;
    }
  };
}
