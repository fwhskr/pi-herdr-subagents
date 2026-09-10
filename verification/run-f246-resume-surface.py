"""Bounded disposable-container probe for the trusted resume amendment."""
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("authority", ROOT / "pi-extension/subagents/launch_authority.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

with tempfile.TemporaryDirectory(prefix="f246-") as directory:
    authority = module.Authority()
    try:
        binding = dict(childSessionId="child", parentSessionId="parent", persona="deep",
                       canonicalProject=directory, workspaceId="workspace", tabId="old-tab", paneId="old-pane")
        surface = dict(workspaceId="workspace", tabId="new-tab", paneId="new-pane")
        worker = [sys.executable, "-c", "import time; time.sleep(10)"]
        first = authority.launch(worker, binding)
        try:
            authority.resume_surface(worker, "child", surface)
            raise AssertionError("concurrent writer accepted")
        except module.AuthorityError as error:
            assert error.code == "CONFLICT"
        os.kill(first, 15)
        deadline = time.monotonic() + 3
        while authority.runs:
            assert time.monotonic() < deadline, "writer exit deadline"
            authority.serve_once(0.01)
        result = Path(directory) / "identity"
        code = ("import socket,json,os; s=socket.socket(fileno=4); "
                "s.send(json.dumps(dict(v=1,op='resolveSelf',requestId='probe')).encode()); "
                "r=json.loads(s.recv(4096)); r['actualPid']=os.getpid(); "
                "open(" + repr(str(result)) + ",'w').write(json.dumps(r))")
        second = authority.resume_surface([sys.executable, "-c", code], "child", surface)
        deadline = time.monotonic() + 3
        while not result.exists():
            assert time.monotonic() < deadline, "identity deadline"
            authority.serve_once(0.01)
        import json
        identity = json.loads(result.read_text())
        assert identity["actualPid"] == second
        assert identity["launchGeneration"] == 2
        for key, value in dict(binding, **surface).items():
            assert identity[key] == value, (key, identity)
        try:
            authority.resume_surface(worker, "unknown", surface)
            raise AssertionError("cold adoption accepted")
        except module.AuthorityError as error:
            assert error.code == "RESUME_REAUTH_REQUIRED"
        print("PASS concurrent writer CONFLICT; exited writer reaped; actual PID and FD 4; generation 2; real new tuple; stable lineage; cold RESUME_REAUTH_REQUIRED")
    finally:
        authority.close()
