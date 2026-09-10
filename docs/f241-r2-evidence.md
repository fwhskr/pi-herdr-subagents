# F-241-R2 local handoff — BLOCKED / UNVERIFIED

This is a work-in-progress commit, not a completed authenticated provider cutover.
Do not install or rely on it for authorization before the required behavioral
fixtures and independent Echo review pass. No Backlog acceptance boxes changed.

## Delivered sources

All paths below are relative to `/home/kris/projects/pi-hs-f241-auth`.

- `docs/authenticated-launch-authority.md`: v1 request/response, exact error set,
  protected bootstrap assumptions, same-user limitations, lifecycle and migration.
- `pi-extension/subagents/launch_authority.py`: Linux trusted supervisor API;
  non-dumpability; actual fork/exec registration gated behind pidfd acquisition;
  inherited socketpair and per-packet kernel credentials; retained-state resume;
  old-generation denial; revocation, exit reaping and explicit cleanup.
- `pi-extension/subagents/launch-identity-native.c`: in-process async N-API client
  on fixed inherited FD 4; 1000ms exchange deadline; no helper-process identity.
- `pi-extension/subagents/launch-identity.ts`: asynchronous resolveSelf API,
  serialized calls, response validation/correlation, fail-closed unavailable path.
- `scripts/build-launch-identity.mjs`: bounded local compiler invocation with
  installed Node headers; generates native binary and clangd compile database.

No legacy launcher code was changed. Herdr's existing command-to-pane API cannot
inherit a delegator descriptor into an already-running shell. Integration belongs
at a trusted process-creation boundary; this standalone supervisor API does not
claim to have wired that boundary. No Sula consumer code was changed.

## Exact checks / outcomes

Working directory for local commands: `/home/kris/projects/pi-hs-f241-auth`.

1. `timeout 60s cc -Wall -Wextra -Werror -fsyntax-only -I/home/kris/.local/share/pi-node/node-v22.23.1-linux-x64/include/node pi-extension/subagents/launch-identity-native.c`
   — exit 0, no diagnostics.
2. `timeout 60s node scripts/build-launch-identity.mjs`
   — exit 0, native shared module built. Generated compile database addressed the
   editor's initial missing `node_api.h` include-path diagnosis. Build success
   does not prove runtime behavior.
3. `timeout 60s npx oxlint pi-extension test`
   — exit 0; captured output: `npm notice run 'oxlint' pi-extension test`.
   Oxlint does not check Python or C and does not supply security verification.
4. First write of new `test/launch-identity-worker.ts` — REFUSED before creation:
   `bounded-test gate: ... is a test or CI-config file. Agents do not edit the
   tests that grade them mid-task. ask Nova to issue a bounded_tests_grant`.
5. One `agent_message` RULE-EXCEPTION to Nova requesting the bounded fixture grant
   — REFUSED: `this session has no valid crew binding; use delegate instead
   through the normal worker workflow`. No retry, alternate writer or gate bypass.

Exploratory checks: Python reports pidfd_open and SCM_CREDENTIALS available;
`/usr/include/node/node_api.h` is absent, but installed Pi Node headers exist at
the explicit include directory above. An exploratory `timeout ... command -v cc`
failed because `command` is a shell builtin; a direct builtin lookup located
`/usr/bin/cc`. These are setup observations, not behavioral test failures.

## Required fixture evidence — NOT RUN

No fixture file exists: the first write was blocked. Thus there is no red/green
forgery output and no assertion that the security behavior passes.

- Forged/replaced sidecar cannot change resolved persona: UNVERIFIED.
- Independently spawned Node/Pi with forged env/session/sidecar: UNVERIFIED.
- Inherited/transferred FD used by a descendant: UNVERIFIED.
- Unknown child: UNVERIFIED.
- Stale generation after trusted resume: UNVERIFIED.
- Authority death -> UNAVAILABLE and zero mailbox effects: UNVERIFIED.
- Malformed/duplicate request and unsupported version: UNVERIFIED.
- Fresh/resume persona/project/session/tuple parity: UNVERIFIED.
- Main-crew denial, duplicate registration, revocation and parent exit: UNVERIFIED.
- Same-project Nova request/reply, forged send/history/receive rejection: UNVERIFIED.

No targeted node --test command, full npm suite, integration/live test or Echo
review ran. New behavior needs the blocked fixtures; existing selectors would
not validate it. No existing test was weakened, deleted or modified. The permitted
full-suite run remains unused (zero of one).

## AC disposition

1. PARTIAL: documented API, authority source and attacker model supplied; cannot
   mark met until implementation matches contract under behavioral verification.
2. NOT MET: supervised launch/resume code exists; parity untested and legacy
   fresh/resume launcher not integrated.
3. NOT MET: refusal paths implemented but untested; no end-to-end authorized DM
   or grant-effect evidence.
4. NOT MET: persona exclusions and lifecycle code exist, not tested.
5. NOT MET: consumer fixture write was blocked.
6. NOT MET: no independent Echo evidence. Commands executed were bounded and no
   live send, mailbox/grant mutation or installed-package edit occurred.
7. PARTIAL: local source revision is the commit containing this report; migration
   and removal contract documented. No publication or installation. Runtime
   integration and eventual owner-authorized cutover remain outstanding.

No AC is represented as complete solely from code presence.

## Cleanup and constraints

No worker or persistent authority was launched. Compiler processes exited.
Generated `compile_commands.json` and `launch-identity-native.node` were removed
using an explicit disposable-build-artifact cleanup; no temporary directories
were created by this lane. The build helper recreates them when authorized.
No push, tag, release, PR, publish, live reload, installed-cache/home edit, real
mailbox/grant mutation or Sula payload modification occurred.

## Unblock requirements

1. Nova must issue a bounded_tests_grant covering new isolated test files in this
   worktree, and arrange independent Echo verification after passing fixtures.
   Current worker mailbox binding cannot deliver the grant request (F-236).
2. Runtime owner must provide a trusted process-spawn/FD-passing integration point
   rather than typing a writable script path into an existing pane. No claim that
   this requires privilege; it requires the correct launch ownership boundary.
3. Owner chooses whether to accept cooperative-consumer-only attestation or
   require isolated/mediated mailbox access. Same-UID direct file access remains
   possible outside this contract.
