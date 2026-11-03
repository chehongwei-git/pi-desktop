/** 可选容量测量：隔离配置、无模型调用，记录 1/5/10 个空闲 Pi 的 RSS 总量。 */
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';

const cli = process.argv[2];
if (!cli)
  throw new Error(
    '用法：node scripts/measure-process-pool.mjs <Pi CLI JS 路径>',
  );
const exec = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), 'pi-pool-memory-'));
const processes = [];
// 三个平台均使用系统只读接口；RSS 包含共享页，求和不是独占物理内存。
async function rss(pids) {
  if (process.platform === 'win32') {
    const { stdout } = await exec(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Get-CimInstance Win32_Process -Filter '${pids.map((pid) => `ProcessId = ${pid}`).join(' OR ')}' | ForEach-Object { $_.WorkingSetSize }`,
      ],
      { windowsHide: true },
    );
    const values = stdout.trim().split(/\s+/).filter(Boolean).map(Number);
    if (
      values.length !== pids.length ||
      values.some((value) => !Number.isFinite(value) || value <= 0)
    )
      return null;
    return values.reduce((sum, value) => sum + value, 0);
  }
  if (process.platform === 'linux') {
    const values = await Promise.all(
      pids.map(async (pid) => {
        const status = await readFile(`/proc/${pid}/status`, 'utf8');
        return Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0) * 1024;
      }),
    );
    return values.reduce((sum, value) => sum + value, 0);
  }
  const { stdout } = await exec('ps', ['-o', 'rss=', '-p', pids.join(',')]);
  return stdout
    .trim()
    .split(/\s+/)
    .reduce((sum, value) => sum + Number(value) * 1024, 0);
}
try {
  const agent = join(root, 'agent');
  await mkdir(agent);
  for (let count = 1; count <= 10; count++) {
    const child = spawn(
      process.execPath,
      [
        resolve(cli),
        '--mode',
        'rpc',
        '--no-session',
        '--no-extensions',
        '--no-mcp',
        '--no-skills',
        '--no-prompt-templates',
        '--no-themes',
        '--no-context-files',
        '--extension',
        resolve('src-tauri/bridge/desktop.mjs'),
      ],
      {
        cwd: root,
        env: { ...process.env, PI_CODING_AGENT_DIR: agent },
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
      },
    );
    processes.push(child);
    await new Promise((resolveReady, reject) => {
      const reader = createInterface({ input: child.stdout });
      const timer = setTimeout(() => reject(new Error('Pi 初始化超时')), 30000);
      child.once('error', reject);
      reader.on('line', (line) => {
        const event = JSON.parse(line);
        if (event.type === 'response' && event.id === 'measure') {
          clearTimeout(timer);
          event.success ? resolveReady() : reject(new Error(event.error));
        }
      });
      child.stdin.write(
        JSON.stringify({ type: 'get_state', id: 'measure' }) + '\n',
      );
    });
    if (processes.some((child) => child.exitCode !== null))
      throw new Error(
        `Pi 提前退出：${processes.map((child) => child.exitCode).join(',')}`,
      );
    if ([1, 5, 10].includes(count)) {
      const bytes = await rss(processes.map((child) => child.pid));
      console.log(
        JSON.stringify({
          processes: count,
          rssMiB: bytes === null ? null : Math.round(bytes / 1024 / 1024),
          emptySessions: true,
          ...(bytes === null
            ? { note: '系统未返回全部进程的有效工作集数据，不能据此估计内存' }
            : {}),
        }),
      );
    }
  }
} finally {
  await Promise.all(
    processes.map(
      (child) =>
        new Promise((resolveExit) => {
          if (child.exitCode !== null) return resolveExit();
          const timer = setTimeout(() => child.kill(), 3000);
          child.once('exit', () => {
            clearTimeout(timer);
            resolveExit();
          });
          child.stdin.end();
        }),
    ),
  );
  await rm(root, { recursive: true, force: true });
}
