"""Linux inherited-channel authority. Embed only in a trusted launch supervisor."""
import ctypes
import json
import os
import re
import select
import signal
import socket
import struct
import uuid

FIELDS = {
    "childSessionId", "parentSessionId", "persona", "canonicalProject",
    "workspaceId", "tabId", "paneId",
}
WORKER_FD = 4


class AuthorityError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def strict_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


class Authority:
    def __init__(self):
        libc = ctypes.CDLL(None, use_errno=True)
        if libc.prctl(4, 0, 0, 0, 0) != 0 or libc.prctl(3, 0, 0, 0, 0) != 0:
            raise AuthorityError("UNAVAILABLE")
        if not hasattr(os, "pidfd_open"):
            raise AuthorityError("UNAVAILABLE")
        self.epoch = str(uuid.uuid4())
        self.history = {}
        self.runs = []
        self.closed = False

    def launch(self, argv, binding):
        if self.closed:
            raise AuthorityError("UNAVAILABLE")
        if (not isinstance(binding, dict) or set(binding) != FIELDS
                or any(not isinstance(v, str) or not v.strip() or len(v) > 4096
                       for v in binding.values())):
            raise AuthorityError("CONFLICT")
        persona = binding["persona"]
        if not re.fullmatch(r"[a-z][a-z0-9-]*", persona) or persona in {"nova", "halo", "echo"}:
            raise AuthorityError("CONFLICT")
        if binding["childSessionId"] == binding["parentSessionId"]:
            raise AuthorityError("CONFLICT")
        if binding["childSessionId"] in self.history:
            raise AuthorityError("CONFLICT")
        project = binding["canonicalProject"]
        if not os.path.isabs(project) or not os.path.isdir(project):
            raise AuthorityError("CONFLICT")
        binding = dict(binding, canonicalProject=os.path.realpath(project))
        return self._spawn(argv, binding, 1)

    def resume(self, argv, child_session_id):
        if self.closed:
            raise AuthorityError("UNAVAILABLE")
        previous = self.history.get(child_session_id)
        if previous is None:
            raise AuthorityError("RESUME_REAUTH_REQUIRED")
        # No worker-controlled resume fields, session text or recovery sidecars.
        return self._spawn(argv, previous["binding"], previous["generation"] + 1)

    def resume_surface(self, argv, child_session_id, surface):
        """Trusted launcher amendment: rebind only after the previous writer exits.

        Never expose this method on the worker resolveSelf channel. The launcher
        supplies newly allocated IDs, not claims recovered from session files.
        """
        if self.closed:
            raise AuthorityError("UNAVAILABLE")
        previous = self.history.get(child_session_id)
        if previous is None:
            raise AuthorityError("RESUME_REAUTH_REQUIRED")
        if (not isinstance(surface, dict)
                or set(surface) != {"workspaceId", "tabId", "paneId"}
                or any(not isinstance(v, str) or not v.strip() or len(v) > 4096
                       for v in surface.values())):
            raise AuthorityError("CONFLICT")
        # Reap through the authority's one reaper before checking retained state.
        self.serve_once(0)
        if any(run["binding"]["childSessionId"] == child_session_id
               for run in self.runs):
            raise AuthorityError("CONFLICT")
        return self._spawn(argv, dict(previous["binding"], **surface),
                           previous["generation"] + 1)

    def _spawn(self, argv, binding, generation):
        if (not isinstance(argv, list) or not argv
                or any(not isinstance(arg, str) or "\0" in arg for arg in argv)):
            raise AuthorityError("CONFLICT")
        server, child = socket.socketpair(socket.AF_UNIX, socket.SOCK_SEQPACKET)
        server.setsockopt(socket.SOL_SOCKET, socket.SO_PASSCRED, 1)
        server.setblocking(False)
        gate_read, gate_write = os.pipe()
        pid = None
        pidfd = None
        try:
            pid = os.fork()
            if pid == 0:
                try:
                    server.close()
                    os.close(gate_write)
                    if os.read(gate_read, 1) != b"1":
                        os._exit(126)
                    os.close(gate_read)
                    os.dup2(child.fileno(), WORKER_FD, inheritable=True)
                    # dup2(fd, fd) is a no-op: explicitly clear CLOEXEC as well.
                    os.set_inheritable(WORKER_FD, True)
                    # All other authority descriptors are CLOEXEC by Python default.
                    os.execvpe(argv[0], argv, os.environ.copy())
                except BaseException:
                    os._exit(127)
            child.close()
            os.close(gate_read)
            gate_read = None
            # Child is gated and owned; no wait/reaping occurs before pidfd_open.
            # Even early child death leaves a zombie, preventing PID reuse here.
            pidfd = os.pidfd_open(pid)
            run = dict(binding=dict(binding), generation=generation, pid=pid,
                       pidfd=pidfd, socket=server, status="active")
            self.runs.append(run)
            for old in self.runs:
                if old is not run and old["binding"]["childSessionId"] == binding["childSessionId"]:
                    old["status"] = "STALE_GENERATION"
            self.history[binding["childSessionId"]] = run
            os.write(gate_write, b"1")
            return pid
        except BaseException:
            if pid:
                if pidfd is not None:
                    signal.pidfd_send_signal(pidfd, signal.SIGKILL)
                else:
                    os.kill(pid, signal.SIGKILL)  # Own unreaped, gated child only.
                os.waitpid(pid, 0)
            if pidfd is not None:
                os.close(pidfd)
            server.close()
            child.close()
            raise
        finally:
            if gate_read is not None:
                os.close(gate_read)
            os.close(gate_write)

    def revoke(self, child_session_id):
        for run in self.runs:
            if run["binding"]["childSessionId"] == child_session_id:
                run["status"] = "REVOKED"

    def _reply(self, run):
        request_id = None
        try:
            raw, ancillary, flags, _ = run["socket"].recvmsg(4096, socket.CMSG_SPACE(12))
            if not raw:
                return
            credentials = [struct.unpack("3i", data) for level, kind, data in ancillary
                           if level == socket.SOL_SOCKET and kind == socket.SCM_CREDENTIALS
                           and len(data) == 12]
            if len(credentials) != 1 or credentials[0][:2] != (run["pid"], os.getuid()):
                raise AuthorityError("UNREGISTERED")
            if flags & (socket.MSG_TRUNC | socket.MSG_CTRUNC):
                raise AuthorityError("MALFORMED_REQUEST")
            try:
                req = json.loads(raw, object_pairs_hook=strict_object)
                if (not isinstance(req, dict) or set(req) != {"v", "op", "requestId"}
                        or req["op"] != "resolveSelf"
                        or not isinstance(req["requestId"], str)
                        or not 1 <= len(req["requestId"]) <= 128
                        or type(req["v"]) is not int):
                    raise ValueError("invalid request")
                request_id = req["requestId"]
            except (ValueError, UnicodeError):
                raise AuthorityError("MALFORMED_REQUEST") from None
            if req["v"] != 1:
                raise AuthorityError("UNSUPPORTED_VERSION")
            if select.select([run["pidfd"]], [], [], 0)[0]:
                raise AuthorityError("REVOKED")
            if run["status"] != "active":
                raise AuthorityError(run["status"])
            response = dict(v=1, requestId=request_id, authorityEpoch=self.epoch,
                            launchGeneration=run["generation"], lifecycle="active", **run["binding"])
        except AuthorityError as error:
            response = dict(v=1, requestId=request_id, error=error.code)
        try:
            run["socket"].send(json.dumps(response).encode())
        except (BlockingIOError, BrokenPipeError, ConnectionResetError):
            pass  # Client times out/refuses; never recover from metadata.

    def serve_once(self, timeout=0.1):
        if self.closed:
            return
        descriptors = [fd for run in self.runs for fd in (run["pidfd"], run["socket"])]
        ready, _, _ = select.select(descriptors, [], [], min(max(timeout, 0), 1))
        for run in self.runs[:]:
            if run["pidfd"] in ready:
                run["status"] = "REVOKED"
                run["socket"].close()
                os.close(run["pidfd"])
                os.waitpid(run["pid"], 0)
                self.runs.remove(run)
            elif run["socket"] in ready:
                try:
                    self._reply(run)
                except (BlockingIOError, ConnectionResetError):
                    pass

    def close(self):
        self.closed = True
        for run in self.runs:
            run["status"] = "REVOKED"
            try:
                signal.pidfd_send_signal(run["pidfd"], signal.SIGKILL)
            except ProcessLookupError:
                pass
            run["socket"].close()
            os.close(run["pidfd"])
            os.waitpid(run["pid"], 0)
        self.runs.clear()
        self.history.clear()
