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
        elif 8 <= case <= 13:
            # Effect counters are an isolated authorization sink, never real DM/grants.
            def refused(action, code='CONFLICT'):
                before = [(run['pid'], run['generation'], dict(run['binding']), run['socket'].fileno(), run['status']) for run in authority.runs]
                history = dict(authority.history)
                try:
                    action()
                except module.AuthorityError as error:
                    assert error.code == code, error.code
                else:
                    raise AssertionError('unauthorized issuance accepted')
                assert authority.history == history
                assert before == [(run['pid'], run['generation'], dict(run['binding']), run['socket'].fileno(), run['status']) for run in authority.runs]

            def no_channel(dest):
                result = subprocess.run([node, worker, 'effects', dest], timeout=4, capture_output=True)
                assert result.returncode == 0, result.stderr
                assert load(dest + '.result') == dict(result=dict(ok=False, error='UNAVAILABLE'), mailboxEffects=0, grantEffects=0)

            def same_identity(first, second):
                # resolveSelf generates a fresh correlation ID for every request.
                assert first['requestId'] != second['requestId']
                assert dict(first, requestId=second['requestId']) == second, (first, second)

            def finish_writer(dest):
                Path(dest + '.go').write_text('go')
                result = await_file(authority, dest + '.result')['result']
                assert result['ok'], result
                deadline = time.monotonic() + 3
                while authority.runs:
                    assert time.monotonic() < deadline, 'writer reaping deadline'
                    authority.serve_once(0.01)
                return result['identity']

            if case == 8:
                for persona in ('nova', 'halo', 'echo'):
                    refused(lambda: authority.launch([node, worker, 'basic', base], dict(binding, persona=persona)))
                    assert not authority.runs and not authority.history
                    assert not Path(base + '.result').exists()
                    no_channel(base + '.' + persona)
                print('PASS case 8 nova/halo/echo: CONFLICT; registrations=0; no identity/channel; DM/grants=0')
            elif case in (9, 10):
                if case == 9:
                    refused(lambda: authority.launch([node, worker, 'basic', base], dict(binding, parentSessionId='child')))
                    assert not authority.runs and not authority.history
                    assert not Path(base + '.result').exists()
                launch('wait')
                first = await_file(authority, base + '.ready')['identity']
                second = binding if case == 9 else dict(binding, persona='researcher', parentSessionId='unrelated', paneId='other-pane')
                refused(lambda: authority.launch([node, worker, 'basic', base + '.duplicate'], second))
                assert len(authority.runs) == len(authority.history) == 1
                assert not Path(base + '.duplicate.result').exists()
                same_identity(first, finish_writer(base))  # Original identity/generation/channel still usable.
                no_channel(base + '.unregistered')
                print('PASS case', case, 'self-parent/duplicate' if case == 9 else 'conflicting active registration', 'CONFLICT; original identity/generation/channel unchanged; refused DM/grants=0')
            elif case == 11:
                Path(base + '.jsonl').write_text(json.dumps(dict(id='unknown', parentSessionId='unrelated', cwd='/other-project')))
                Path(base + '.jsonl.spawn.json').write_text(json.dumps(dict(agent='nova', **binding)))
                os.environ['PI_SUBAGENT_SESSION'] = base + '.jsonl'
                os.environ['PI_SUBAGENT_ID'] = 'nova'
                refused(lambda: authority.resume([node, worker, 'basic', base], 'unknown'), 'RESUME_REAUTH_REQUIRED')
                refused(lambda: authority.resume_surface([node, worker, 'basic', base], 'unknown', {key: binding[key] for key in ('workspaceId', 'tabId', 'paneId')}), 'RESUME_REAUTH_REQUIRED')
                assert not authority.runs and not authority.history
                assert not Path(base + '.result').exists()
                no_channel(base + '.unregistered')
                print('PASS case 11 unknown session/unrelated parent: RESUME_REAUTH_REQUIRED on both resume APIs; forged recovery ignored; no identity/channel; DM/grants=0')
            elif case == 12:
                launch('claims')
                result = await_file(authority, base + '.result')
                assert result['before']['ok'] and result['after']['ok'], result
                same_identity(result['before']['identity'], result['after']['identity'])
                for key, value in binding.items():
                    assert result['after']['identity'][key] == value
                assert len(result['responses']) == 8
                for response in result['responses']:
                    assert response == dict(v=1, requestId=None, error='MALFORMED_REQUEST'), response
                assert result['mailboxEffects'] == result['grantEffects'] == 0
                assert load(base + '.descendant.result') == dict(result=dict(ok=False, error='UNREGISTERED'), mailboxEffects=0, grantEffects=0)
                print('PASS case 12 seven individual/all worker identity claims: MALFORMED_REQUEST; real identity unchanged; descendant UNREGISTERED; cross-project DM/grants=0')
            else:
                # A delegator exits while the independent trusted authority retains state.
                parent_code = "import sys,json; from pathlib import Path; Path(sys.argv[1]).write_text(sys.argv[2]); sys.stdin.read()"
                parent = subprocess.Popen([sys.executable, '-c', parent_code, base + '.binding', json.dumps(binding)], stdin=subprocess.PIPE)
                try:
                    trusted = await_file(authority, base + '.binding')
                    authority.launch([node, worker, 'wait', base], trusted)
                    first = await_file(authority, base + '.ready')['identity']
                    assert parent.poll() is None
                    parent.communicate(timeout=3)
                    assert parent.returncode == 0
                    same_identity(first, finish_writer(base))
                finally:
                    if parent.poll() is None:
                        parent.kill()
                    parent.wait(timeout=3)
                Path(base + '.jsonl.spawn.json').write_text(json.dumps(dict(agent='nova', canonicalProject='/other-project')))
                os.environ['PI_SUBAGENT_SESSION'] = base + '.jsonl'
                surface = dict(workspaceId='new-workspace', tabId='new-tab', paneId='new-pane')
                authority.resume_surface([node, worker, 'wait', base + '.resumed'], 'child', surface)
                resumed = await_file(authority, base + '.resumed.ready')['identity']
                assert first['launchGeneration'] == 1 and resumed['launchGeneration'] == 2
                assert first['authorityEpoch'] == resumed['authorityEpoch']
                for key, value in dict(binding, **surface).items():
                    assert resumed[key] == value
                same_identity(resumed, finish_writer(base + '.resumed'))
                authority.close()
                authority = module.Authority()
                refused(lambda: authority.resume_surface([node, worker, 'basic', base + '.cold'], 'child', surface), 'RESUME_REAUTH_REQUIRED')
                assert not authority.runs and not authority.history
                assert not Path(base + '.cold.result').exists()
                no_channel(base + '.unregistered')
                print('PASS case 13 delegator exit + writer reaped: trusted surface resume generation 1 -> 2, stable lineage/project; cold authority RESUME_REAUTH_REQUIRED; no unregistered identity/channel; refused DM/grants=0')
        elif case in (14, 15):
            def denied(attempt, code):
                response = json.loads(attempt['received'])
                assert response == dict(v=1, requestId=None if code in ('UNREGISTERED', 'MALFORMED_REQUEST') else 'captured-replay', error=code), response

            for variant in (('superseded', 'revoked') if case == 14 else ('response',)):
                dest = base + '.' + variant
                mode = 'replay' if case == 14 else 'response-replay'
                authority.launch([node, worker, mode, dest], binding)
                captured = await_file(authority, dest + '.ready')
                identity = json.loads(captured['received'])
                assert 'error' not in identity and identity['launchGeneration'] == 1, identity
                for key, value in binding.items():
                    assert identity[key] == value
                assert captured['sent'] == '{ "v":1, "op":"resolveSelf", "requestId":"captured-replay" }'
                if variant == 'superseded':
                    # Legacy resume intentionally retains a live stale channel. Production uses resume_surface.
                    authority.resume([node, worker, 'wait', dest + '.new'], 'child')
                    fresh = await_file(authority, dest + '.new.ready')['identity']
                    assert fresh['launchGeneration'] == 2
                    code = 'STALE_GENERATION'
                elif variant == 'revoked':
                    authority.revoke('child')
                    code = 'REVOKED'
                else:
                    code = 'MALFORMED_REQUEST'
                Path(dest + '.go').write_text('go')
                result = await_file(authority, dest + '.result')
                assert result['captured'] == captured
                attempt, = result['attempts']
                assert attempt['sent'] == captured['sent' if case == 14 else 'received']
                denied(attempt, code)
                assert result['mailboxEffects'] == result['grantEffects'] == 0
                descendant = load(dest + '.descendant.result')
                other, = descendant['attempts']
                assert other['sent'] == captured['sent']
                denied(other, 'UNREGISTERED')
                assert descendant['mailboxEffects'] == descendant['grantEffects'] == 0
                # Sensitivity control: the exact valid response MUST fail every refusal assertion.
                for refusal in (code, 'UNREGISTERED'):
                    try:
                        denied(captured, refusal)
                    except AssertionError:
                        pass
                    else:
                        raise AssertionError('refusal check accepted captured valid identity')
                if case == 15:
                    assert len(result['reused']) == 2
                    for reused in result['reused']:
                        assert reused['sent'] == captured['sent']
                        assert json.loads(reused['received']) == identity
                    assert len(authority.history) == 1
                    assert authority.history['child']['generation'] == 1
                    print('PASS case 15 captured response -> MALFORMED_REQUEST; requestId reused twice: same pinned identity/generation=1; descendant UNREGISTERED; replay DM/grants=0; refusal sensitivity PASS; transaction scope consumer-side')
                else:
                    assert not result['reused']
                    print('PASS case 14', variant, 'verbatim captured request ->', code, '; descendant UNREGISTERED; no replay identity/usable authorization; DM/grants=0; refusal sensitivity PASS')
                authority.close()
                authority = module.Authority()
        else:
            raise ValueError('case must be 1..15')
    finally:
        authority.close()
