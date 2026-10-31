/** 跨平台真实 Pi 冒烟：临时目录、假密钥、不调用模型，验证目录加载与思考等级。 */
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const directory = await mkdtemp(join(tmpdir(), 'pi-desktop-models-'));
const pending = new Map();
let serial = 0;
let child;
try {
  await writeFile(
    join(directory, 'models.json'),
    JSON.stringify({
      providers: {
        'desktop-test': {
          api: 'openai-responses',
          baseUrl: 'http://127.0.0.1:1/v1',
          models: [
            {
              id: 'test-model',
              contextWindow: 200000,
              maxTokens: 32000,
              input: ['text', 'image'],
              reasoning: true,
              thinkingLevelMap: { high: 'high', xhigh: null, max: 'max' },
            },
          ],
        },
      },
    }),
  );
  await writeFile(
    join(directory, 'auth.json'),
    // 移除端点后可以保留认证，但 models.json 中不能因此重建空 provider。
    JSON.stringify({
      'desktop-test': { type: 'api_key', key: 'test-only' },
      EE: { type: 'api_key', key: 'retained-test-only' },
    }),
  );
  await writeFile(
    join(directory, 'settings.json'),
    JSON.stringify({
      defaultProvider: 'desktop-test',
      defaultModel: 'test-model',
      modelThinkingLevels: { 'desktop-test/test-model': 'max' },
    }),
  );
  // 显式入口支持 Windows JS 安装；不通过 cmd 或 shell 执行。
  const entry = process.argv[2] || 'pi';
  const script = /\.[cm]?js$/i.test(entry);
  const args = [
    '--mode',
    'rpc',
    '--no-session',
    '--no-extensions',
    '--no-tools',
    '--extension',
    fileURLToPath(new URL('../src-tauri/bridge/desktop.mjs', import.meta.url)),
  ];
  child = spawn(
    script ? process.execPath : entry,
    script ? [resolve(entry), ...args] : args,
    {
      cwd: directory,
      env: { ...process.env, PI_CODING_AGENT_DIR: directory, PI_OFFLINE: '1' },
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    },
  );
  child.on('error', () => {
    for (const p of pending.values())
      p.reject(new Error('无法启动 Pi，请传入可执行入口或 CLI JS 路径'));
  });
  const lines = createInterface({ input: child.stdout });
  const extensionErrors = [];
  lines.on('line', (line) => {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (event.type === 'extension_error') extensionErrors.push(event.error);
    const request = pending.get(event.id);
    if (event.type !== 'response' || !request) return;
    pending.delete(event.id);
    clearTimeout(request.timer);
    if (event.success) request.resolve(event.data);
    else request.reject(new Error('Pi RPC 拒绝请求'));
  });
  function request(type, fields = {}) {
    return new Promise((resolve, reject) => {
      const id = String(++serial);
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('Pi RPC 超时'));
      }, 15000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
    });
  }
  const state = await request('get_state');
  if (state.model?.id !== 'test-model' || state.thinkingLevel !== 'max')
    throw new Error('模型或默认思考等级未加载');
  const available = await request('get_available_models');
  const model = available.models.find((m) => m.id === 'test-model');
  if (
    !model ||
    model.contextWindow !== 200000 ||
    model.maxTokens !== 32000 ||
    !model.input.includes('image')
  )
    throw new Error('模型参数未加载');
  const levels = await request('get_available_thinking_levels');
  if (!levels.levels.includes('max') || levels.levels.includes('xhigh'))
    throw new Error('等级映射不符合配置');
  await request('prompt', { message: '/pi-desktop-models-v1' });
  if (extensionErrors.length) throw new Error('桥接刷新出错');
  const after = await request('get_state');
  if (after.sessionId !== state.sessionId) throw new Error('刷新改变了会话');
  console.log(
    '真实 Pi 模型参数、图片能力、max 默认等级、禁用 xhigh 与模型刷新通过；未调用模型。',
  );
} finally {
  for (const p of pending.values()) clearTimeout(p.timer);
  if (child) {
    child.stdin.end();
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      const timer = setTimeout(() => {
        child.kill();
        resolve();
      }, 3000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  await rm(directory, { recursive: true, force: true });
}
