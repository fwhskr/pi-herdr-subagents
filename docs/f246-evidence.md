# F-246 partial implementation evidence

This lane is **not complete**. No authenticated Herdr launch capability, private
launcher bootstrap, provider fresh/resume adapter, PTY session setup or completion
relay was implemented. The new method below is a tested producer primitive, not
an integrated launch path. No acceptance criterion is marked complete.

## Changes

`Authority.resume_surface(argv, childSessionId, surface)` is trusted-launcher-only
and is not a worker wire operation. It accepts exactly workspaceId/tabId/paneId,
services the authority's existing reaper, refuses while any writer for the session
remains, retains persona/project/child session/original parent, and increments the
generation. Unknown retained history returns RESUME_REAUTH_REQUIRED. FD 4 and
kernel packet credentials are unchanged. The old low-level `resume` operation is
unchanged to preserve the F-241 stale-channel probes; **it is not safe for the
production session-writer adapter**. The future adapter must use resume_surface.

The build script accepts an optional build-time staging directory and emits
`launch-identity-native.node` there. Place it beside the F-236 consumer module
using the package producer, not a runtime-selected module path. The provider owns
the C source and build; Sula owns assembly of its consumer package. No assembly
or runtime installation was performed here. Existing no-argument output remains
compatible with the provider client and F-241 probes.

## Verification

All successful commands below exited 0; none timed out. Rootless containers use
network=none, read-only root/source, isolated tmpfs and HOME, no live sockets or
mailboxes. Container auto-removal uses the safe-delete escape hatch exclusively
for disposable container state.

Commands are reproducible from the provider checkout; `ROOT` below means its
absolute path and is a shell variable, not a repository-specific identity.

```sh
timeout 60s node "$ROOT/scripts/build-launch-identity.mjs"
timeout 60s node --check "$ROOT/scripts/build-launch-identity.mjs"
```

Both silent success. Python ast.parse of the authority and new probe also passed
(`PASS Python syntax`) without writing bytecode.

Each of these seven selectors was executed separately, not in one timeout:

```sh
LUMI_PERMIT_HARD_DELETE=1 timeout 60s podman run --rm --network none --read-only --tmpfs /tmp:rw --env HOME=/tmp/home --volume "$ROOT:/src:ro" localhost/sula-f2218-native:local python3 -B /src/verification/run-f241-launch-authority.py 1 /usr/bin/node
LUMI_PERMIT_HARD_DELETE=1 timeout 60s podman run --rm --network none --read-only --tmpfs /tmp:rw --env HOME=/tmp/home --volume "$ROOT:/src:ro" localhost/sula-f2218-native:local python3 -B /src/verification/run-f241-launch-authority.py 2 /usr/bin/node
LUMI_PERMIT_HARD_DELETE=1 timeout 60s podman run --rm --network none --read-only --tmpfs /tmp:rw --env HOME=/tmp/home --volume "$ROOT:/src:ro" localhost/sula-f2218-native:local python3 -B /src/verification/run-f241-launch-authority.py 3 /usr/bin/node
LUMI_PERMIT_HARD_DELETE=1 timeout 60s podman run --rm --network none --read-only --tmpfs /tmp:rw --env HOME=/tmp/home --volume "$ROOT:/src:ro" localhost/sula-f2218-native:local python3 -B /src/verification/run-f241-launch-authority.py 4 /usr/bin/node
LUMI_PERMIT_HARD_DELETE=1 timeout 60s podman run --rm --network none --read-only --tmpfs /tmp:rw --env HOME=/tmp/home --volume "$ROOT:/src:ro" localhost/sula-f2218-native:local python3 -B /src/verification/run-f241-launch-authority.py 5 /usr/bin/node
LUMI_PERMIT_HARD_DELETE=1 timeout 60s podman run --rm --network none --read-only --tmpfs /tmp:rw --env HOME=/tmp/home --volume "$ROOT:/src:ro" localhost/sula-f2218-native:local python3 -B /src/verification/run-f241-launch-authority.py 6 /usr/bin/node
LUMI_PERMIT_HARD_DELETE=1 timeout 60s podman run --rm --network none --read-only --tmpfs /tmp:rw --env HOME=/tmp/home --volume "$ROOT:/src:ro" localhost/sula-f2218-native:local python3 -B /src/verification/run-f241-launch-authority.py 7 /usr/bin/node
```

Seven selectors cover **four underlying scenarios**, not seven independent E2E
workflows. 1/2/7: `forged sidecar/env: deep; inherited FD second process:
UNREGISTERED`; 3: `MALFORMED_REQUEST; version: UNSUPPORTED_VERSION; no channel:
UNAVAILABLE`; 4/6: `generation 1 -> 2; STALE_GENERATION; REVOKED; effects=0`;
5: `authority SIGKILL: UNAVAILABLE; no persona; mailboxEffects=0`.
These used the newly built provider-adjacent native artifact, not Sula assembly.

```sh
LUMI_PERMIT_HARD_DELETE=1 timeout 60s podman run --rm --network none --read-only --tmpfs /tmp:rw --env HOME=/tmp/home --volume "$ROOT:/src:ro" docker.io/library/python:3.12-bookworm python3 -B /src/verification/run-f246-resume-surface.py
```

Output: `PASS concurrent writer CONFLICT; exited writer reaped; actual PID and
FD 4; generation 2; real new tuple; stable lineage; cold RESUME_REAUTH_REQUIRED`.
No red-before-green run was captured; independent Echo remains outstanding.

Build-time staging was additionally checked with a Python TemporaryDirectory,
subprocess timeouts of 40s/5s, invoking the build script with that directory,
then Node require of the generated module and asserting exchange is a function.
Output: `PASS staged native exchange load`. The first attempt at this command
had Python quoting SyntaxError (exit 1); corrected heredoc passed. No production
change was needed. The first container invocation was rejected before execution
by the safe-delete guard interpreting `--rm`; the scoped disposable-state escape
hatch resolved it. Container tool discovery found Node and Python but no cc or
Node headers (exit 1), so compilation used the host's existing toolchain.

## Limits / handoff

AC1/2: no new launch seam; existing authority guarantees only. AC3: unproven.
AC4: old authority probes pass; zero production-consumer effects are unproven.
AC5: surface rebind primitive proven; adapter/lifecycle integration absent.
AC6: no live mutation, but completion/interrupt/legacy fixture not exercised.
AC7: staging primitive and ownership documentation partial; no compatible
end-to-end release. AC8: isolated local probes passed, no independent Echo.

Outstanding container/VM lane: actual Herdr PTY to actual Pi to production F-236
request/reply/history/watcher proof, missing native module and forged consumer
metadata, legacy no-fallback, interrupt/completion, and distinct same-persona
briefs. Containers are reachable: this gap is unfinished implementation, not an
infrastructure blocker. Full suite is CI lane; Herdr compile is not applicable
to this documentation-only Herdr change.

Migration remains owner-operated. Existing panes are never attested retroactively;
a reload does not supply FD 4. Authority loss requires reauthorization. Rollback
must not silently restore legacy authenticated execution. No F-166 payload,
installed-cache change, release, push, merge or live pane operation occurred.
