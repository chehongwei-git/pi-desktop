/** 用本机 Pi 的真实序列化器验证 Anthropic 格式；假密钥且在发送前截断，不访问网络。 */
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import desktopBridge from '../src-tauri/bridge/desktop.mjs';

// 显式传入 pi-ai 的 dist/api/anthropic-messages.js，避免绑定全局安装位置。
if (!process.argv[2])
  throw new Error('请传入 pi-ai 的 dist/api/anthropic-messages.js 路径');
const { streamSimple } = await import(
  pathToFileURL(resolve(process.argv[2])).href
);
const events = new Map();
let level = 'high';
desktopBridge({
  on: (name, handler) => events.set(name, handler),
  registerCommand() {},
  getThinkingLevel: () => level,
});
const model = {
  id: 'arbitrary-model-alias',
  provider: 'desktop-test',
  api: 'anthropic-messages',
  baseUrl: 'http://127.0.0.1:1',
  reasoning: true,
  contextWindow: 200000,
  maxTokens: 32000,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const ctx = { model };
// 用无型号含义的别名验证两种能力与错误学习路径，避免测试依赖型号特判。
for (const mode of ['adaptive', 'budget', 'learned']) {
  model.compat =
    mode === 'learned'
      ? undefined
      : { forceAdaptiveThinking: mode === 'adaptive' };
  delete model.thinkingLevelMap;
  events.get('session_start')({}, ctx);
  if (mode === 'learned') {
    events.get('message_end')(
      {
        message: {
          role: 'assistant',
          stopReason: 'error',
          errorMessage: 'model requires adaptive thinking',
        },
      },
      ctx,
    );
  }
  for (const [strength, effort] of Object.entries({
    off: undefined,
    minimal: 'low',
    low: 'low',
    medium: 'medium',
    high: 'high',
    xhigh: 'high',
    max: 'max',
  })) {
    level = strength;
    events.get('session_start')({}, ctx);
    let captured;
    await streamSimple(
      model,
      {
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'test' }],
            timestamp: 0,
          },
        ],
      },
      {
        apiKey: 'test-only',
        reasoning: strength === 'off' ? undefined : strength,
        onPayload(payload) {
          captured =
            events.get('before_provider_request')({ payload }, ctx) ?? payload;
          throw new Error('验证已捕获请求，禁止实际发送');
        },
        fetch() {
          throw new Error('验证禁止网络访问');
        },
      },
    ).result();
    assert.ok(captured, '必须经过真实请求序列化');
    if (mode === 'budget') {
      if (effort) {
        assert.equal(captured.thinking.type, 'enabled');
        assert.ok(captured.thinking.budget_tokens > 0);
      } else {
        assert.ok(!captured.thinking || captured.thinking.type === 'disabled');
      }
      assert.equal(captured.output_config?.effort, undefined);
    } else if (effort) {
      assert.equal(captured.thinking.type, 'adaptive');
      assert.equal(captured.output_config.effort, effort);
      assert.equal(captured.thinking.budget_tokens, undefined);
    } else {
      assert.equal(captured.thinking, undefined);
      assert.equal(captured.output_config?.effort, undefined);
    }
    console.log(`${mode} / ${strength}: OK`);
  }
}
