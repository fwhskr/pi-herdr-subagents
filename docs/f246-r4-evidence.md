# F-246 R4 checkpoint

Stage 1 succeeded: full Herdr application builds inside a disposable rootless
container with Zig 0.15.2 and Rust 1.98.0. No host toolchain installation.
Stage 2 partial: atomic Linux CLOEXEC PTY allocation fixes the identified window.
Application callers, actual pane tuples and actor attachment remain absent.
Stage 3 NOT IMPLEMENTED: no provider adapter. No production behavior is claimed
from successful compilation. Full application launch and legacy-unchanged proofs
were NOT RUN because the application integration is absent.

## Recipe

Use the prepared Herdr checkout as HERDR and a disposable absolute directory as
CACHE. Export git archive HEAD to CACHE/herdr.tar; copy the checked-in
verification/authenticated-launch-probe/container-build.sh to CACHE/build.sh.

```sh
LUMI_PERMIT_HARD_DELETE=1 timeout 900s podman run --rm --read-only --tmpfs /tmp:rw --volume "$CACHE:/cache:rw,Z" docker.io/library/rust:latest sh /cache/build.sh
```

The executed image ID was
ab239914c9d2fbe5ef024c5314dae21e2a2c43618086e169d78a754429978b97.
The recipe downloads the version-pinned upstream Zig archive, not a host install:
https://ziglang.org/download/0.15.2/zig-x86_64-linux-0.15.2.tar.xz
The tested Rust toolchain was rustc 1.98.0 (88d9e12ae 2026-08-18), cargo 1.98.0.
For deterministic image reuse supply the image ID instead of the mutable tag.
Source is an archive; no live worktree, home, desktop or sockets are mounted.
The :Z suffix is required for this SELinux host's disposable cache volume.

## Evidence

1. Container network/toolchain preflight: timeout 60s podman run --rm --read-only
   --tmpfs /tmp:rw docker.io/library/rust:latest sh -c with rustc/cargo --version,
   curl --fail --location --connect-timeout 10 --max-time 40 of the above archive,
   tar -xJf, then zig version. Exit 0: Rust 1.98.0, Zig 0.15.2.
2. First 900s container build invocation lacked :Z. Exit 2:
   `cannot open /cache/build.sh: Permission denied`. Inspecting podman info showed
   SELinuxEnabled=true; corrected only the disposable mount label.
3. Corrected 900s build command above. Exit 0:
   `Finished dev profile ... in 1m 24s`. Three dead-code warnings explicitly
   confirm AuthenticatedSupervisor/AuthenticatedPty have no application callers.
4. After copying the changed authenticated.rs into the isolated source, command:

```sh
LUMI_PERMIT_HARD_DELETE=1 timeout 900s podman run --rm --read-only --tmpfs /tmp:rw --volume "$CACHE:/cache:rw,Z" --env HOME=/cache/home --env CARGO_HOME=/cache/cargo --env CARGO_TARGET_DIR=/cache/target --env ZIG_GLOBAL_CACHE_DIR=/cache/zig-cache --env ZIG=/cache/zig-x86_64-linux-0.15.2/zig docker.io/library/rust:latest sh -c 'cargo build --offline --locked --manifest-path /cache/source/Cargo.toml && cargo build --offline --locked --manifest-path /cache/source/verification/authenticated-launch-probe/Cargo.toml'
```

Application compilation passed in 4.35s. Overall exit 101 because the probe's
separate lockfile needed uncached libc 0.2.189 and --offline prevented download.
No unchanged rerun: enabled container network for the probe dependencies:

```sh
LUMI_PERMIT_HARD_DELETE=1 timeout 60s podman run --rm --read-only --tmpfs /tmp:rw --volume "$CACHE:/cache:rw,Z" --env HOME=/cache/home --env CARGO_HOME=/cache/cargo --env CARGO_TARGET_DIR=/cache/target docker.io/library/rust:latest cargo build --locked --manifest-path /cache/source/verification/authenticated-launch-probe/Cargo.toml
```

Exit 0: `Finished dev profile ... in 3.21s`.

```sh
LUMI_PERMIT_HARD_DELETE=1 timeout 60s podman run --rm --network none --read-only --tmpfs /tmp:rw --env HOME=/tmp/home --volume "$PROVIDER:/provider:ro" --volume "$CACHE/target/debug/authenticated-launch-probe:/probe:ro,Z" localhost/sula-f2218-native:local /probe /usr/bin/python3 /provider/pi-extension/subagents/launch-supervisor.py
```

Exit 0:

```text
PASS Rust PTY -> supervisor -> worker: generation=1, actual PID, FD4, tty, cwd/env, descendant UNREGISTERED, real exit=23
PASS Rust PTY -> supervisor -> worker: generation=2, actual PID, FD4, tty, cwd/env, descendant UNREGISTERED, real exit=23
PASS concurrent writer refused; new PTY resume; unsupported version refused without legacy path
```

One behavioral execution; no cap hit; total verification wall-clock unmeasured.
Generated cache intentionally retained outside repositories for incremental work.
Container teardown automatic. No host toolchain, runtime install or live mutation.

## Remaining acceptance work

AC1/2 partial: real PTY transport, not actual application pane allocation or caller.
AC3 unproven: need application integration and F-236 production entry points for
send, history and receiving that resolve FD 4 via the adjacent native module,
plus fixture-only Nova/session mailboxes with no model/network or grant access.
No F-236 revision was inspected this round; do not claim that lane blocks this
round's absent application wiring.
AC4/5 partial: existing transport proof, no caller/consumer effects proof.
AC6 unproven: completion/interrupt, legacy pane preservation and artifact workflows.
AC7 partial: documented toolchain and migration, no usable integrated revision.
AC8 partial: full build and isolated probe; independent Echo absent.

Old resume remains for stale-channel probes. The supervisor calls resume_surface.
The future provider adapter must use that surface, never the old resume.

Next implementation: retain supervisor in Herdr runtime, assign actual pane tuple,
attach the returned master to PaneRuntime's actor and consume supervisor status
without another worker reaper; expose issuance only through a trusted launcher
bootstrap, not ordinary pane JSON. Then implement structured provider requests.
Seven F-241 selectors NOT RUN this round (provider runtime unchanged; prior-round
four-scenario evidence retained). Full suite NOT RUN: CI lane. Production proof
NOT RUN: container/VM lane after implementation. No push, merge or publication.
