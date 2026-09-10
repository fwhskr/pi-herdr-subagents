import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('authority', ROOT / 'pi-extension/subagents/launch_authority.py')
assert spec is not None and spec.loader is not None
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
worker = str(ROOT / 'verification/worker-f241.mjs')
node = sys.argv[2]
case = int(sys.argv[1])

def load(path):
    return json.loads(Path(path).read_text())

def await_file(authority, path):
    deadline = time.monotonic() + 8
    while not Path(path).exists():
        assert time.monotonic() < deadline, 'deadline: ' + path
        authority.serve_once(0.01)
    return load(path)

with tempfile.TemporaryDirectory(prefix='f241-', dir='/tmp') as directory:
    authority = module.Authority()
    try:
        base = directory + '/worker'
        binding = dict(childSessionId='child', parentSessionId='parent', persona='deep', canonicalProject=directory, workspaceId='workspace', tabId='tab', paneId='pane')
        def launch(mode, dest=base):
            return authority.launch([node, worker, mode, dest], binding)
        if case in (1, 2, 7):
            launch('forge')
            result = await_file(authority, base + '.result')
            other = load(base + '.descendant.result')
            assert result['ok'] and result['identity']['persona'] == 'deep', result
            assert other == dict(ok=False, error='UNREGISTERED'), other
            print('PASS case', case, 'forged sidecar/env: deep; inherited FD second process: UNREGISTERED')
        elif case == 3:
            launch('raw')
            result = await_file(authority, base + '.result')
            assert result == ['MALFORMED_REQUEST', 'UNSUPPORTED_VERSION', 'MALFORMED_REQUEST'], result
            absent = subprocess.run([node, worker, 'basic', base + '.unknown'], timeout=4, capture_output=True)
            assert absent.returncode == 0, absent.stderr
            assert load(base + '.unknown.result') == dict(ok=False, error='UNAVAILABLE')
            print('PASS case 3 malformed/duplicate: MALFORMED_REQUEST; version: UNSUPPORTED_VERSION; no channel: UNAVAILABLE')
        elif case in (4, 6):
            launch('wait')
            fresh = await_file(authority, base + '.ready')['identity']
            resumed_base = base + '.resumed'
            authority.resume([node, worker, 'wait', resumed_base], 'child')
            resumed = await_file(authority, resumed_base + '.ready')['identity']
            assert fresh['launchGeneration'] == 1 and resumed['launchGeneration'] == 2
            for field in binding:
                assert fresh[field] == resumed[field] == binding[field]
            Path(base + '.go').write_text('go')
            stale = await_file(authority, base + '.result')
            assert stale == dict(result=dict(ok=False, error='STALE_GENERATION'), mailboxEffects=0), stale
            authority.revoke('child')
            Path(resumed_base + '.go').write_text('go')
            revoked = await_file(authority, resumed_base + '.result')
            assert revoked == dict(result=dict(ok=False, error='REVOKED'), mailboxEffects=0), revoked
            print('PASS case', case, 'fresh/resume tuple parity; generation 1 -> 2; STALE_GENERATION; REVOKED; effects=0')
        elif case == 5:
            # A separate supervisor dies; this process adopts/reaps the orphan.
            import ctypes
            import signal
            ctypes.CDLL(None).prctl(36, 1, 0, 0, 0)
            pid = os.fork()
            if pid == 0:
                try:
                    launch('wait')
                    while True:
                        authority.serve_once(0.01)
                finally:
                    os._exit(1)
            adopted = None
            try:
                deadline = time.monotonic() + 8
                while not Path(base + '.ready').exists():
                    assert time.monotonic() < deadline
                    time.sleep(0.01)
                assert load(base + '.ready')['ok']
                os.kill(pid, signal.SIGKILL)
                os.waitpid(pid, 0)
                pid = None
                Path(base + '.go').write_text('go')
                deadline = time.monotonic() + 5
                while not Path(base + '.result').exists():
                    assert time.monotonic() < deadline
                    time.sleep(0.01)
                result = load(base + '.result')
                assert result == dict(result=dict(ok=False, error='UNAVAILABLE'), mailboxEffects=0), result
                print('PASS case 5 authority SIGKILL: UNAVAILABLE; no persona; mailboxEffects=0')
            finally:
                if pid:
                    os.kill(pid, signal.SIGKILL)
                    os.waitpid(pid, 0)
                # Only children of this isolated fixture, never live panes.
                children = Path('/proc/self/task/' + str(os.getpid()) + '/children').read_text().split()
                for child in children:
                    try:
                        os.kill(int(child), signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    os.waitpid(int(child), 0)
        else:
            raise ValueError('case must be 1..7')
    finally:
        authority.close()
