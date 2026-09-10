# F-246 R3: private PTY transport checkpoint

## Implemented

The provider `pi-extension/subagents/launch-supervisor.py` is a separate,
non-dumpable launcher-owned process. Its FD 0 is a bootstrap-established private
Unix datagram socket; it creates no filesystem listener. The worker receives a
new PTY slave via SCM_RIGHTS. Only launch/resume/status/close exist on this private
control surface; requests cannot register an existing PID. Worker FD 4 remains
selector-free resolveSelf. Strict request fields and version checks refuse other
operations. The supervisor remains alive after workers exit, retains authority
history and exits/cleans workers when its launcher pidfd signals death or on close.

`launch_authority.py` now accepts trusted keyword-only cwd/env/tty_fd. In the
single-threaded supervisor's gated child it creates a terminal session, attaches
the slave as controlling TTY and stdio, preserves the tty across FD 4 collision,
sets cwd and directly execs structured argv/environment. Existing socketpair,
pidfd registration-before-gate-release and per-packet credentials remain intact.
Its existing sole reaper now retains actual waitstatus_to_exitcode results.

The private supervisor resume operation calls **resume_surface**, never the old
low-level `resume`. The old method remains exclusively for F-241 stale-channel
compatibility probes and must not be used for production session writers.

Herdr `src/pty/authenticated.rs` owns supervisor startup through Command (not a
Python fork inside Herdr), a private socketpair and fresh openpty per request. It
passes the slave with SCM_RIGHTS, validates the version-1 handshake, queries real
exit codes and bounds cleanup. Trusted supervisor paths are supplied internally,
not selected by pane API or environment. Python starts with -I and explicitly
imports from the configured trusted supervisor directory only.

## Honest boundary

This is a Stage 1 **transport checkpoint**, not a completed authenticated launch
operation. No AppState pane tuple is allocated, no PaneRuntime actor is attached,
no public capability advertised, and no provider caller adapter added. Fixture
IDs in the probe are expressly NOT real Herdr pane IDs. The Rust module is compiled
in Herdr but currently has no application callers. Before multithreaded integration,
resolve the openpty-to-CLOEXEC race against concurrent launches. The single-threaded
probe cannot prove that race absent.

The actual Pi/F-236 consumer proof is UNPROVEN because application and adapter
wiring are absent; it is not blamed on a container outage or an unavailable Sula
revision. Next: wire a retained supervisor owner into Herdr runtime; atomically
allocate/register actual new pane tuples and attach the returned PTY to its actor;
expose a private trusted launch capability; then adapt provider fresh/resume with
structured argv, artifacts, activity and completion routing. No public command
may accept an arbitrary authoritative binding.

## Commands and results

Variables below denote absolute checkout paths, supplied by the operator:
`HERDR` is the prepared Herdr worktree; `PROVIDER` is this provider worktree.
Each command was its own capped invocation. No timeout occurred.

```sh
timeout 600s cargo check --manifest-path "$HERDR/Cargo.toml" --offline
```
Exit 101: `failed to execute zig build for vendored libghostty-vt: ... No such
file or directory`. Not retried unchanged. Full Herdr check remains BLOCKED by
missing Zig. No installation attempted. The 600s budget was authorized for builds.

```sh
timeout 600s cargo build --offline --manifest-path "$HERDR/verification/authenticated-launch-probe/Cargo.toml"
```
Exit 0: `Finished dev profile ... in 2.87s`. This focused crate includes the exact
production Rust source; no copied mock transport or terminal UI build dependency.

```sh
LUMI_PERMIT_HARD_DELETE=1 timeout 60s podman run --rm --network none --read-only --tmpfs /tmp:rw --env HOME=/tmp/home --volume "$PROVIDER:/provider:ro" --volume "$HERDR/verification/authenticated-launch-probe/target/debug/authenticated-launch-probe:/probe:ro" localhost/sula-f2218-native:local /probe /usr/bin/python3 /provider/pi-extension/subagents/launch-supervisor.py
```
Exit 0:

```text
PASS Rust PTY -> supervisor -> worker: generation=1, actual PID, FD4, tty, cwd/env, descendant UNREGISTERED, real exit=23
PASS Rust PTY -> supervisor -> worker: generation=2, actual PID, FD4, tty, cwd/env, descendant UNREGISTERED, real exit=23
PASS concurrent writer refused; new PTY resume; unsupported version refused without legacy path
```

This is a **Python worker**, not Pi or Node. No mailbox effects are exercised.
All state is isolated, network disabled, source read-only, no live desktop socket
mounts. The owner Drop sends close and bounds the supervisor reap; Python finally
closes the authority and inherited descriptors; the disposable container is
removed automatically. Hard-delete permission applies only to container removal.

```sh
timeout 60s node "$PROVIDER/scripts/build-launch-identity.mjs"
```
Exit 0, silent. The seven unchanged F-241 selectors were rerun separately using
the newly staged native module; **four scenarios**, not seven E2E workflows.
For each explicit selector 1, 2, 3, 4, 5, 6, 7 the exact invocation was:

```sh
LUMI_PERMIT_HARD_DELETE=1 timeout 60s podman run --rm --network none --read-only --tmpfs /tmp:rw --env HOME=/tmp/home --volume "$PROVIDER:/src:ro" localhost/sula-f2218-native:local python3 -B /src/verification/run-f241-launch-authority.py SELECTOR /usr/bin/node
```

Every exit 0. 1/2/7: `forged sidecar/env: deep; inherited FD second process:
UNREGISTERED`; 3: `MALFORMED_REQUEST; version: UNSUPPORTED_VERSION; no channel:
UNAVAILABLE`; 4/6: `generation 1 -> 2; STALE_GENERATION; REVOKED; effects=0`;
5: `authority SIGKILL: UNAVAILABLE; no persona; mailboxEffects=0`.

Rustfmt on the two new Rust sources exited 0 after the focused proof; no behavioral
rerun after formatting-only edits. Python ast.parse on authority and supervisor
exited 0 (`PASS authority and supervisor Python syntax`). No existing test was
weakened. No red-before-green proof or independent Echo is claimed.

## AC status

1 partial: real transport PTY proven, actual application pane tuple/worker Pi absent.
2 partial: private control schema and main-crew exclusions, no caller integration.
3 unproven: production consumer request/reply/history/receive absent.
4 partial: authority fail-closed probes and transport capability refusal, no consumer effects proof.
5 partial: transport new-PTY warm resume and writer gate, no provider adapter.
6 unproven: UI completion, interrupts, orphan/legacy and distinct brief workflows absent.
7 partial: native staging and ownership/migration documented, no integrated revision.
8 partial: isolated local proof, no independent Echo and full Herdr build blocked.

Eight behavioral executions this round. Verification total elapsed time was not
measured. Full suite: CI lane. Full Herdr check: missing build prerequisite.
Production Pi/F-236 and remaining lifecycle checks: container/VM lane after
implementation. No live install, restart, reload, publication, merge or push.
