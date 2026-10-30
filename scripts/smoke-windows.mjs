/** Windows 原生冒烟：通过 Node 启动 exe，PowerShell 仅检查窗口并投递 WM_CLOSE。无项目、无 Pi 会话。 */
import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
if (process.platform !== 'win32') throw new Error('Windows only');
const child = spawn(resolve('src-tauri/target/release/pi-desktop.exe'), [], {
  stdio: 'ignore',
});
const exited = new Promise((resolve, reject) => {
  child.once('exit', (code) => resolve(code));
  child.once('error', reject);
});
/** 使用事件循环延迟等待原生窗口，不阻塞代理交互线程。 */
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  await pause(3000);
  if (child.exitCode !== null)
    throw new Error(`Application exited early: ${child.exitCode}`);
  const probe = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `$p=Get-Process -Id ${child.pid}; @{title=$p.MainWindowTitle;responding=$p.Responding;window=[long]$p.MainWindowHandle;hostWorkingSetBytes=$p.WorkingSet64}|ConvertTo-Json -Compress`,
    ],
    { encoding: 'utf8' },
  );
  if (probe.status !== 0) throw new Error(probe.stderr);
  const result = JSON.parse(probe.stdout);
  if (!result.window || !result.responding)
    throw new Error('Native window unavailable');
  const close = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `(Get-Process -Id ${child.pid}).CloseMainWindow()`,
    ],
    { encoding: 'utf8' },
  );
  // WM_CLOSE 可能在 PowerShell 输出布尔值前完成，最终以子进程退出为准。
  if (close.status !== 0) throw new Error(`WM_CLOSE failed: ${close.stderr}`);
  result.exitCode = await Promise.race([
    exited,
    pause(10000).then(() => {
      throw new Error('Shutdown timeout');
    }),
  ]);
  if (result.exitCode !== 0) throw new Error(`Exit code ${result.exitCode}`);
  await mkdir('test-results', { recursive: true });
  await writeFile(
    'test-results/native-smoke.json',
    JSON.stringify(result, null, 2),
  );
  console.log(result);
} finally {
  if (child.exitCode === null) child.kill();
}
