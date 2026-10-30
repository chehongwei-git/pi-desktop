"""真实 Pi RPC 桥接冒烟：隔离配置、无模型请求，验证重载后桥接仍在。"""
import json
import os
from pathlib import Path
import select
import shutil
import subprocess
import tempfile
import time

root = Path(__file__).resolve().parent.parent
pi = shutil.which('pi')
if not pi:
    raise SystemExit('找不到 Pi')
with tempfile.TemporaryDirectory(prefix='pi-desktop-verify-') as directory:
    env = dict(os.environ, PI_CODING_AGENT_DIR=directory)
    process = subprocess.Popen(
        [pi, '--mode', 'rpc', '--no-session', '--no-extensions', '--no-tools',
         '--extension', str(root / 'src-tauri/bridge/desktop.mjs')],
        cwd=directory, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    buffer = b''
    def request(number, kind, **fields):
        global buffer
        process.stdin.write((json.dumps(dict(id=str(number), type=kind, **fields)) + '\n').encode())
        process.stdin.flush()
        deadline = time.monotonic() + 20
        errors = []
        while time.monotonic() < deadline:
            if b'\n' not in buffer:
                ready, _, _ = select.select([process.stdout], [], [], max(0, deadline - time.monotonic()))
                if not ready:
                    break
                chunk = os.read(process.stdout.fileno(), 65536)
                if not chunk:
                    raise AssertionError('Pi 提前退出')
                buffer += chunk
                continue
            line, buffer = buffer.split(b'\n', 1)
            event = json.loads(line)
            if event.get('type') == 'extension_error':
                errors.append(event.get('error'))
            if event.get('type') == 'response' and event.get('id') == str(number):
                assert event.get('success'), event
                assert not errors, errors
                return event.get('data')
        raise AssertionError('Pi RPC 响应超时')
    try:
        before = request(1, 'get_state')
        commands = request(2, 'get_commands')['commands']
        assert any(c['name'] == 'pi-desktop-reload-v1' for c in commands)
        assert request(3, 'prompt', message='/pi-desktop-reload-v1')['disposition'] == 'handled'
        commands = request(4, 'get_commands')['commands']
        assert any(c['name'] == 'pi-desktop-models-v1' for c in commands)
        assert request(5, 'prompt', message='/pi-desktop-models-v1')['disposition'] == 'handled'
        entries = request(7, 'get_entries')
        assert isinstance(entries['entries'], list)
        after = request(6, 'get_state')
        assert before.get('sessionId') == after.get('sessionId')
        assert not after.get('isStreaming')
        print('真实 Pi 桥接加载、热重载、模型刷新通过；会话保持，无模型请求。')
    finally:
        process.stdin.close()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
