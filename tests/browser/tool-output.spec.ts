/** 直接挂载真实输出组件，用浏览器布局验证折行、动态行高和窗口缩放。 */
import { test, expect } from '@playwright/test';

test('tool output wraps in independent scroll boxes after resizing', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/tool-output-fixture', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html><head><meta charset="utf-8"></head><body>
      <main class="transcript" style="width: min(760px, 100%); height: 800px; margin: auto; padding: 16px"></main>
      <script type="module" src="/tests/browser/tool-output-fixture.ts"></script></body></html>`,
    }),
  );
  await page.goto('/tool-output-fixture');
  const blocks = page.locator('.tool-code');
  await expect(blocks).toHaveCount(3);
  const code = blocks.nth(1);
  for (const width of [1200, 480, 900]) {
    await page.setViewportSize({ width, height: 900 });
    await code.evaluate((node) => {
      const root = node.closest('.transcript')!;
      root.scrollTop +=
        node.getBoundingClientRect().top - root.getBoundingClientRect().top;
    });
    await expect
      .poll(() =>
        blocks.evaluateAll((nodes) =>
          nodes.every((node) => node.scrollWidth <= node.clientWidth + 1),
        ),
      )
      .toBe(true);
    await expect
      .poll(() =>
        code
          .locator('.tool-code-line')
          .first()
          .evaluate((node) => node.getBoundingClientRect().height),
      )
      .toBeGreaterThan(22);
    // 实际测量后的相邻行应紧密衔接，不能沿用固定行高导致重叠。
    await expect
      .poll(() =>
        code
          .locator('.tool-code-line')
          .evaluateAll((nodes) =>
            nodes
              .slice(1)
              .every(
                (node, i) =>
                  Math.abs(
                    node.getBoundingClientRect().top -
                      nodes[i].getBoundingClientRect().bottom,
                  ) < 1,
              ),
          ),
      )
      .toBe(true);
    expect(await code.locator('.tool-code-line').count()).toBe(501);
    const outerTop = await page
      .locator('main')
      .evaluate((node) => node.scrollTop);
    await code.focus();
    // 未测量行进入视口后会修正总高度，持续定位到实际末尾。
    await expect
      .poll(async () => {
        await code.evaluate((node) => {
          node.scrollTop = node.scrollHeight;
        });
        return code.getByText('最后一行', { exact: true }).isVisible();
      })
      .toBe(true);
    expect(
      await code.evaluate((node) => node.clientHeight),
    ).toBeLessThanOrEqual(380);
    expect(await page.locator('main').evaluate((node) => node.scrollTop)).toBe(
      outerTop,
    );
  }
  await page.screenshot({ path: 'test-results/tool-wrap-light.png' });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
  });
  await page.screenshot({ path: 'test-results/tool-wrap-dark.png' });
  expect(errors).toEqual([]);
});
