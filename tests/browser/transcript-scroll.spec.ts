/** 连续滚动诊断记录真实文字坐标和滚动写入，不用自动定位控件掩盖跳动。 */
import { test, expect } from '@playwright/test';

type Frame = {
  type: 'frame';
  input: number;
  top: number;
  height: number;
  errors: number[];
};
type Write = { type: 'write'; top: number; target: unknown; stack?: string };

for (const kind of ['text', 'mixed', 'expanded']) {
  for (const driver of ['native', 'controlled']) {
    test(`continuous upward scrolling preserves text anchors after switching to ${kind} history (${driver})`, async ({
      page,
    }) => {
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.route('**/transcript-scroll-fixture', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><html><head><meta charset="utf-8"></head><body><main style="height:100vh;display:flex;flex-direction:column"></main><script type="module" src="/tests/browser/transcript-scroll-fixture.ts"></script></body></html>`,
        }),
      );
      await page.goto('/transcript-scroll-fixture');
      await page.waitForFunction(
        () => typeof (window as any).switchHistory === 'function',
      );
      await page.evaluate((kind) => (window as any).switchHistory(kind), kind);
      const transcript = page.locator('.transcript');
      await expect(page.locator('.message-item')).toHaveCount(240);
      await expect
        .poll(() =>
          transcript.evaluate(
            (node) => node.scrollHeight - node.scrollTop - node.clientHeight,
          ),
        )
        .toBeLessThan(3);
      // 对话滚动在正文框外发起，避免将内部滚动误算为对话输入。
      const box = (await transcript.boundingBox())!;
      await page.mouse.move(box.x + 4, box.y + box.height / 2);
      await page.evaluate(
        ({ driver, steps }) => {
          const root = document.querySelector<HTMLElement>('.transcript')!;
          const host = window as any;
          const trace: (Frame | Write)[] = [];
          host.trace = trace;
          host.tracing = true;
          let input = 0;
          root.addEventListener('wheel', (event) => {
            input += event.deltaY;
          });
          const original = root.scrollTo.bind(root);
          root.scrollTo = ((options: ScrollToOptions) => {
            trace.push({
              type: 'write',
              target: options,
              stack: new Error().stack,
              top: root.scrollTop,
            });
            original(options);
          }) as typeof root.scrollTo;
          let anchors = new Map<Element, { top: number; input: number }>();
          let step = 0;
          host.scrollDone = false;
          const sample = () => {
            const area = root.getBoundingClientRect();
            const errors: number[] = [];
            const next = new Map<Element, { top: number; input: number }>();
            // 原生滚轮与测量独立执行；逐帧比较同一文字。受控模式精确记录每次输入位移。
            for (const el of root.querySelectorAll(
              '.markdown p, .tool-code-line',
            )) {
              const rect = el.getBoundingClientRect();
              if (rect.bottom <= area.top || rect.top >= area.bottom) continue;
              const anchor = anchors.get(el);
              if (anchor)
                errors.push(rect.top - anchor.top + input - anchor.input);
              // 阅读锚点取视口顶部的文字；其下方尚未测量的行折行不应被误判为锚点漂移。
              if (!next.size) next.set(el, { top: rect.top, input });
            }
            anchors = next;
            trace.push({
              type: 'frame',
              input,
              top: root.scrollTop,
              height: root.scrollHeight,
              errors,
            });
            if (driver === 'controlled' && step++ < steps) {
              root.dispatchEvent(
                new WheelEvent('wheel', { deltaY: -160, bubbles: true }),
              );
              root.scrollTop -= 160;
            } else if (driver === 'controlled') host.scrollDone = true;
            if (host.tracing) requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
        },
        { driver, steps: 90 },
      );
      // 不等待每次测量稳定；长输出跨越多张卡片，覆盖重复进入未测量区域。
      if (driver === 'native') {
        for (let i = 0; i < 90; i++) await page.mouse.wheel(0, -160);
      } else await page.waitForFunction(() => (window as any).scrollDone);
      await page.waitForTimeout(250);
      const trace: (Frame | Write)[] = await page.evaluate(() => {
        const host = window as any;
        host.tracing = false;
        return host.trace;
      });
      await test.info().attach('scroll-trace', {
        body: JSON.stringify(trace),
        contentType: 'application/json',
      });
      // 防止锚点全部被回收或输入未送达时出现“没有异常样本”的假通过。
      const frames = trace.filter(
        (entry): entry is Frame => entry.type === 'frame',
      );
      const steps = 90;
      expect(frames.at(-1)?.input).toBe(-160 * steps);
      expect(
        frames.filter((frame) => frame.errors.length > 0).length,
      ).toBeGreaterThan(steps / 2);
      // 原生滚轮事件与滚动可错开一帧，基准也可能在这两者之间建立；容许一个输入步长。
      const jumps = trace.filter(
        (r): r is Frame =>
          r.type === 'frame' &&
          r.errors.some(
            (error) => Math.abs(error) > (driver === 'native' ? 162 : 2),
          ),
      );
      expect(jumps.slice(0, 3)).toEqual([]);
      expect(errors).toEqual([]);
      expect(await page.locator('.message-item').count()).toBe(240);
      expect(await page.locator('.virtual-item, .virtual-code').count()).toBe(
        0,
      );
    });
  }
}
