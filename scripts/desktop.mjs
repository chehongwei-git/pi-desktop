import { createServer } from 'vite';
import { run } from '@tauri-apps/cli';
import { pathToFileURL } from 'node:url';

/** 共用启动进程持有 Vite 监听端口，避免 npm/shell 孙进程在 Tauri 退出后残留。 */
export async function startDesktop(args = [], dependencies = { createServer, run }) {
  const server = await dependencies.createServer({ server: { host: '127.0.0.1' } });
  try {
    await server.listen();
    server.printUrls();
    // 仅覆盖本次开发启动的钩子；直接使用 tauri dev 时仍保留原有前端启动方式。
    await dependencies.run([
      'dev',
      '--config',
      JSON.stringify({ build: { beforeDevCommand: null } }),
      ...args,
    ], 'npm run desktop');
  } finally {
    // 正常返回及启动失败均主动释放；CLI 直接退出时由操作系统回收同进程端口。
    await server.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startDesktop(process.argv.slice(2)).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
