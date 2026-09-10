"""Launcher-owned authority process; FD 0 is a private inherited datagram socket.

Not a pane command or public listener. The trusted launcher alone receives the
peer endpoint, and supplies a new PTY slave by SCM_RIGHTS for every launch.
"""
import array
import json
import os
import select
import socket

from launch_authority import Authority, AuthorityError, strict_object


def main():
    control = socket.socket(fileno=0)
    if control.family != socket.AF_UNIX or control.type != socket.SOCK_DGRAM:
        raise RuntimeError("private datagram bootstrap required")
    os.set_inheritable(0, False)
    authority = Authority()
    launcher = os.pidfd_open(os.getppid())
    try:
        control.send(b'{"v":1,"capability":"authenticated-worker"}')
        while True:
            authority.serve_once(0)
            ready = select.select([control, launcher], [], [], 0.01)[0]
            if launcher in ready:
                return
            if control not in ready:
                continue
            raw, ancillary, flags, _ = control.recvmsg(65536, socket.CMSG_SPACE(4 * 16), socket.MSG_CMSG_CLOEXEC)
            descriptors = []
            for level, kind, data in ancillary:
                if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
                    values = array.array("i")
                    values.frombytes(data[:len(data) - len(data) % values.itemsize])
                    descriptors.extend(values)
            try:
                if flags & (socket.MSG_TRUNC | socket.MSG_CTRUNC):
                    raise AuthorityError("MALFORMED_REQUEST")
                request = json.loads(raw, object_pairs_hook=strict_object)
                if not isinstance(request, dict) or type(request.get("v")) is not int:
                    raise AuthorityError("MALFORMED_REQUEST")
                if request["v"] != 1:
                    raise AuthorityError("UNSUPPORTED_VERSION")
                op = request.get("op")
                if op in ("launch", "resume"):
                    identity_fields = {"binding"} if op == "launch" else {"childSessionId", "surface"}
                    if set(request) != {"v", "op", "argv", "cwd", "env"} | identity_fields or len(descriptors) != 1:
                        raise AuthorityError("MALFORMED_REQUEST")
                    options = dict(cwd=request["cwd"], env=request["env"], tty_fd=descriptors[0])
                    if request["cwd"] is None or request["env"] is None:
                        raise AuthorityError("CONFLICT")
                    if op == "launch":
                        pid = authority.launch(request["argv"], request["binding"], **options)
                    else:
                        # Production writer semantics: never use low-level resume,
                        # which exists only for stale-channel compatibility probes.
                        pid = authority.resume_surface(request["argv"], request["childSessionId"], request["surface"], **options)
                    response = dict(v=1, pid=pid)
                elif op == "status" and set(request) == {"v", "op"} and not descriptors:
                    response = dict(v=1, runs=[dict(childSessionId=r["binding"]["childSessionId"],
                        pid=r["pid"], generation=r["generation"], exitCode=r.get("exitCode"))
                        for r in authority.history.values()])
                elif op == "close" and set(request) == {"v", "op"} and not descriptors:
                    return
                else:
                    raise AuthorityError("MALFORMED_REQUEST")
            except AuthorityError as error:
                response = dict(v=1, error=error.code)
            except (ValueError, TypeError, OSError):
                response = dict(v=1, error="MALFORMED_REQUEST")
            finally:
                for descriptor in descriptors:
                    os.close(descriptor)
            control.send(json.dumps(response).encode())
    finally:
        authority.close()
        control.close()
        os.close(launcher)


if __name__ == "__main__":
    main()
