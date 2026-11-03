import assert from 'node:assert/strict';
import { createServer as createTcpServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { createServer } from 'vite';
import { startDesktop } from './desktop.mjs';

// 使用真实监听端口验证生命周期，不启动原生窗口或依赖 Rust 编译。
test('桌面退出或 CLI 启动失败后，同一端口可以再次监听', async () => {
  let port = 0;
  for (const fail of [false, true, false]) {
    const launch = startDesktop(['--no-watch'], {
      createServer: () => createServer({
        configFile: false,
        server: { host: '127.0.0.1', port, strictPort: true },
        logLevel: 'silent',
      }),
      run: async (args) => {
        assert.deepEqual(args, [
          'dev', '--config',
          JSON.stringify({ build: { beforeDevCommand: null } }), '--no-watch',
        ]);
        if (fail) throw new Error('模拟 CLI 启动失败');
      },
    });
    if (fail) await assert.rejects(launch, /模拟 CLI 启动失败/);
    else await launch;
    // 第一次选择空闲端口，后续启动固定使用该端口，避免干扰正在开发的实例。
    const probe = createTcpServer();
    await new Promise((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(port, '127.0.0.1', resolve);
    });
    port = probe.address().port;
    await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  }
});

// Windows 的 Node kill(SIGINT) 是强制终止；Unix 则发送真实信号，两者均应释放监听端口。
test('启动器被中断后释放其持有的端口', { timeout: 15000 }, async () => {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { startDesktop } from ${JSON.stringify(new URL('./desktop.mjs', import.meta.url).href)};
    import { createServer } from 'vite';
    await startDesktop([], {
      createServer: async () => {
        const server = await createServer({ configFile: false, logLevel: 'silent', server: { host: '127.0.0.1', port: 0 } });
        server.printUrls = () => process.send(server.httpServer.address().port);
        return server;
      },
      run: () => new Promise(() => {}),
    });
  `], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const exited = once(child, 'exit');
  try {
    const [port] = await once(child, 'message', { signal: AbortSignal.timeout(10000) });
    child.kill('SIGINT');
    await exited;
    const probe = createTcpServer();
    await new Promise((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(port, '127.0.0.1', resolve);
    });
    await new Promise((resolve) => probe.close(resolve));
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  }
});

test('端口已被占用时不启动 Tauri，也不关闭占用者', async () => {
  const owner = createTcpServer();
  await new Promise((resolve) => owner.listen(0, '127.0.0.1', resolve));
  try {
    let launched = false;
    await assert.rejects(startDesktop([], {
      createServer: () => createServer({
        configFile: false,
        server: { host: '127.0.0.1', port: owner.address().port, strictPort: true },
        logLevel: 'silent',
      }),
      run: async () => { launched = true; },
    }), /already in use/);
    assert.equal(launched, false);
    assert.equal(owner.listening, true);
  } finally {
    await new Promise((resolve) => owner.close(resolve));
  }
});
