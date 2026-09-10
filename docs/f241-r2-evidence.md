# F-241 R2/R3b evidence — supervised probes pass; integration incomplete

Repository: `/home/kris/projects/pi-hs-f241-auth`.
Branch: `task/f241-authenticated-launch-identity`.
Initial implementation: `a3df2775f4edce52a38d8a0526d41e844349f098`.
The commit containing this updated report records the probes and CLOEXEC fix.
No release, installation, Sula cutover or Backlog acceptance update occurred.

## Sources and behavior

- `pi-extension/subagents/launch_authority.py`: non-dumpable Linux supervisor,
  private socketpairs, gated fork/exec with pidfd registration, per-packet
  SCM_CREDENTIALS, retained-state resume, generation invalidation and revocation.
- `pi-extension/subagents/launch-identity-native.c`: asynchronous in-process Node
  client, fixed FD 4, 1000ms exchange deadline.
- `pi-extension/subagents/launch-identity.ts`: resolveSelf, schema/correlation
  validation, no identity selector and no metadata fallback.
- `verification/run-f241-launch-authority.py`: isolated supervisor probes, explicit
  selectors, monotonic deadlines, disposable `/tmp/f241-*` directories, cleanup.
- `verification/worker-f241.mjs`: actual Node worker using the production client;
  forged metadata/environment, inherited-FD descendant, protocol/refusal probes.
- `docs/authenticated-launch-authority.md`: contract, assumptions and migration.

R2's first fixture write under `test/` was refused by the bounded-test gate;
one Nova grant request was refused for no valid crew binding. R3b explicitly
sanctioned NEW probes under `verification/`, while durable suite registration
remains deferred until grants are available. No existing test or CI file changed.

## Ordered failure / repair evidence

The first case-1 run exited 1:

```
AssertionError: {'ok': False, 'error': 'UNAVAILABLE'}
```

Diagnosis, exit 0:

```
timeout 10s python3 -c 'import os,socket; a,b=socket.socketpair(); print(b.fileno(),os.get_inheritable(b.fileno())); os.dup2(b.fileno(),b.fileno(),inheritable=True); print(os.get_inheritable(b.fileno()))'
4 False
False
```

Root cause: when the child endpoint was already FD 4, dup2(4,4) was a no-op and
left CLOEXEC enabled despite the Python inheritable argument. The channel was
closed on exec. `_spawn` now explicitly calls `os.set_inheritable(WORKER_FD, True)`
after dup2. The identical case-1 command then passed. One fix attempt; no timeout
or unchanged failure rerun. This is red/green evidence for inherited-channel
startup, not a newly reproduced legacy Sula mailbox exploit.

## Exact bounded commands and outputs

Working directory: `/home/kris/projects/pi-hs-f241-auth`.
Each command below ran separately, with exit 0 after the repair.

Build:

```
timeout 60s node scripts/build-launch-identity.mjs
```

No output; compiled native module successfully with `-Wall -Wextra -Werror`.

### 1 — forged sidecar

```
timeout 60s python3 -B verification/run-f241-launch-authority.py 1 /home/kris/.local/share/pi-node/node-v22.23.1-linux-x64/bin/node
PASS case 1 forged sidecar/env: deep; inherited FD second process: UNREGISTERED
```

Worker writes a sidecar claiming researcher, rewrites session/environment and
resolves as deep. Authority never reads those files.

### 2 — independently spawned process with forged environment/session/sidecar

```
timeout 60s python3 -B verification/run-f241-launch-authority.py 2 /home/kris/.local/share/pi-node/node-v22.23.1-linux-x64/bin/node
PASS case 2 forged sidecar/env: deep; inherited FD second process: UNREGISTERED
```

Scope limitation: the child is a real Node process loading the production client,
NOT the full Pi CLI. It inherits the forged environment pointing at forged files
AND the connected FD. Rejection proves caller-PID enforcement, not Pi integration.
Literal self-spawned Pi verification remains outstanding.

### 3 — missing channel, malformed/duplicate request, incompatible version

```
timeout 60s python3 -B verification/run-f241-launch-authority.py 3 /home/kris/.local/share/pi-node/node-v22.23.1-linux-x64/bin/node
PASS case 3 malformed/duplicate: MALFORMED_REQUEST; version: UNSUPPORTED_VERSION; no channel: UNAVAILABLE
```

An unregistered sender possessing the channel is covered by cases 2/7;
a process without the inherited channel returns UNAVAILABLE.

### 4 — stale generation and revocation

```
timeout 60s python3 -B verification/run-f241-launch-authority.py 4 /home/kris/.local/share/pi-node/node-v22.23.1-linux-x64/bin/node
PASS case 4 fresh/resume tuple parity; generation 1 -> 2; STALE_GENERATION; REVOKED; effects=0
```

Both old and new workers are live during reauthorization. Old worker refuses as
stale; revoking the new registration refuses as revoked. No modeled mailbox effect.

### 5 — real authority death

```
timeout 60s python3 -B verification/run-f241-launch-authority.py 5 /home/kris/.local/share/pi-node/node-v22.23.1-linux-x64/bin/node
PASS case 5 authority SIGKILL: UNAVAILABLE; no persona; mailboxEffects=0
```

The fixture kills the actual serving supervisor after a successful resolveSelf,
then asks the surviving worker to resolve again. Parent fixture becomes a Linux
subreaper solely to clean up/reap the orphan. No real mailbox is used: the effect
count is an isolated success-only consumer branch, not Sula DM integration.

### 6 — trusted resume parity

```
timeout 60s python3 -B verification/run-f241-launch-authority.py 6 /home/kris/.local/share/pi-node/node-v22.23.1-linux-x64/bin/node
PASS case 6 fresh/resume tuple parity; generation 1 -> 2; STALE_GENERATION; REVOKED; effects=0
```

Asserts every trusted binding field: persona, canonicalProject, childSessionId,
parentSessionId, workspaceId/tabId/paneId. Generation advances 1 to 2. This is
same-live-supervisor resume; cold adoption and legacy-launcher resume are not shown.

### 7 — transferable descriptor

```
timeout 60s python3 -B verification/run-f241-launch-authority.py 7 /home/kris/.local/share/pi-node/node-v22.23.1-linux-x64/bin/node
PASS case 7 forged sidecar/env: deep; inherited FD second process: UNREGISTERED
```

Node spawn passes the connected FD as descriptor 4 to a second real process.
SCM_CREDENTIALS rejects that process rather than returning the first worker's
persona. This probes inheritance/stdio descriptor transfer, not a separate
SCM_RIGHTS-sendmsg transfer. A registered worker deliberately proxying requests
inside its own process remains outside the guarantee.

Static check:

```
timeout 60s npx oxlint pi-extension test verification
npm notice run 'oxlint' pi-extension test verification
```

Exit 0. R2 also passed the explicit C syntax check and `npx oxlint pi-extension test`.
Oxlint does not validate Python/C or prove security behavior.

## AC disposition

1. PARTIAL / protection-conditional: versioned API, authority, threat model and
   error semantics documented; key channel behaviors now demonstrated. Protected
   bootstrap assumptions and complete schema/security validation need Echo review.
2. PASS for the isolated supervised API under stated assumptions; NOT MET for
   legacy launch integration. Trusted fresh/resume tuple parity demonstrated.
3. PARTIAL: sidecar/env impersonation, unknown process, stale, revoked, malformed,
   duplicate JSON and unavailable refusals demonstrated. Duplicate issuance,
   conflicting/unrelated-parent/cross-project binding checks and full Sula
   DM/grant-effect regression evidence remain outstanding.
4. PARTIAL: live-supervisor resume and authority death demonstrated. Main-crew
   exclusion, original-worker-exit-then-resume and cold-adoption denial lack probes.
5. NOT MET: no full same-project Nova request/reply/history/receive-mailbox fixture.
   Zero effects here refers only to the isolated conditional effect counter.
6. NOT MET: no independent Echo pass. All probes bounded and isolated; no live
   sends, installed-package edits or mailbox/grant-store mutations.
7. MET for local revision/migration documentation and no-publication boundary;
   supported deployment/cutover remains owner-gated and is not delivered.

No acceptance boxes changed. This report does not equate seven passing selectors
with all seven task acceptance criteria being complete.

## Remaining blockers / checks not run

- No full Pi CLI probe, legacy Herdr integration, Sula DM workflow or independent
  Echo verification. These are not covered by the Node caller-credential checks.
- No existing targeted node --test selectors or full npm suite ran in R3b:
  production TS/legacy paths were unchanged; focused new probes cover the Python
  fix. Full-suite allowance remains unused. Durable test-suite entry is deferred
  by the R3b ruling until test grants are available.
- No live UI/integration commands, installation, push, tag, release, publish or PR.

## Launcher gap and residual — unchanged by probes

The trusted Herdr pane process-creation path needs an FD-aware spawn operation:
create/receive the private endpoint, carry it as FD 4 across exec, and gate actual
worker exec until pidfd-backed registration completes. Ownership is the Herdr
pane/process-spawn repository plus this provider's caller integration; no claim
is made about an inspected exact Herdr source filename. Writing a script path
into an existing pane cannot do this. Without a trusted equivalent, current
legacy workers have no v1 attestation and must remain unauthorized.

Owner chooses cooperative-consumer attestation versus isolated/mediated mailbox
access. Direct same-user file access remains outside this contract. None of the
passing probes alters that residual or requires a claim that privilege is inherent.

## Cleanup

Each probe owns a TemporaryDirectory under `/tmp` and cleans it in finally.
Supervisors close/revoke, kill only owned children and reap them; the death probe
also reaps its adopted child. No persistent processes or fixture directories are
intentionally retained. Generated native binary and compile database are removed
after verification; build helper recreates them. `-B` prevents Python bytecode
artifacts. No real mailbox or grant store was opened.
