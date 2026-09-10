# Worker launch authority v1 (F-241)

Status: local-fork implementation; **not enabled by the legacy Herdr launcher**.
No release, installation, or Sula consumer cutover is authorized by this change.

## Authority and threat model

Privilege is not inherently required for launch attestation. A trusted supervisor
owns an in-memory launch table, creates a private AF_UNIX SOCK_SEQPACKET socketpair
per launch, forks the actual worker, opens a pidfd before reaping is possible,
registers the child, then releases its exec gate. No registration-on-first-request,
filesystem listener, key file, sidecar, environment claim or roster is accepted.

Linux Python 3.9+ with pidfd_open, SO_PASSCRED/SCM_CREDENTIALS and prctl is required.
The authority calls PR_SET_DUMPABLE(0), checks it, and fails startup otherwise.
A pidfd, not PID/start-time comparison, pins each live child. Exit revokes the
registration, closes the channel and reaps the child. No root operation is needed.

The socketpair is inherited on FD 4 by the actual worker. Unlike SO_PEERCRED on a
pre-fork socketpair (which identifies the creator, not necessarily the sender),
SCM_CREDENTIALS authenticates **each packet's sending process**. The native client
sends inside the real Node worker, not a helper subprocess. An inheriting or
SCM_RIGHTS-receiving descendant can possess the descriptor but is UNREGISTERED:
its kernel PID does not match the pinned child. A registered worker can deliberately
proxy requests for someone else; this protocol does not prevent collusion or
hostile code executing within that very same worker process.

Trust prerequisites: the supervisor, its launch instructions, interpreter/native
module/code and bootstrap caller are trusted before launch and remain unmodified.
The embedding launcher must deliver FD 4 through trusted process creation, not a
worker-selected environment FD or pathname. A hostile process can launch its own
fake authority: responses submitted by that process are NEVER credentials. A
consumer must use the channel supplied by its trusted launcher, not accept a
JSON response from another process. Non-dumpability protects the running authority,
not a writable executable before exec, nor an unprotected delegating process.
Root/CAP_SYS_PTRACE and kernel compromise are outside this boundary. Same-UID
signals may kill the authority: that is fail-closed denial of service.

## Consumer contract

Source API: `pi-extension/subagents/launch-identity.ts`, `resolveSelf():
Promise<LaunchIdentityResult>`. Load/build the adjacent native module before
launch (see test build command); no runtime compiler invocation or downloaded
binary. Linux only; a missing module/channel returns UNAVAILABLE.

Wire request (one UTF-8 JSON packet, maximum 4096 bytes):

```json
{"v":1,"op":"resolveSelf","requestId":"unique-nonempty-string"}
```

Exactly those three keys; no persona, session, project, PID, generation, token or
other selector. requestId is 1–128 characters. Calls are serialized by the TS
client. Each exchange has a 1000 ms native deadline. Invalid JSON, oversized
packets, invalid operations/fields or invalid requestId return MALFORMED_REQUEST.
An otherwise valid request with a different integer version returns
UNSUPPORTED_VERSION. Duplicate JSON object keys are malformed, not last-wins.

Successful wire response:

```json
{"v":1,"requestId":"...","authorityEpoch":"uuid","launchGeneration":1,"childSessionId":"...","parentSessionId":"...","persona":"deep","canonicalProject":"/canonical/project","workspaceId":"...","tabId":"...","paneId":"...","lifecycle":"active"}
```

All identity strings are nonempty. Persona is lowercase ASCII `[a-z][a-z0-9-]*`;
`nova`, `halo`, `echo` are unissuable (case variants are invalid too). The trusted
issuer supplies a canonical existing project directory; the authority realpaths
it, never derives it from worker cwd. IDs identify sessions, not writable session
paths. The provider tuple is workspaceId/tabId/paneId. Epoch is random per
authority lifetime; generation monotonically increases per childSessionId.

Error response: `{"v":1,"requestId":"..."|null,"error":"CODE"}`.
API result: `{ok:true, identity: <successful response>}` or
`{ok:false, error: <code>}`; never throws for verification failure.

* UNAVAILABLE: missing channel/module, disconnect, dead authority, I/O failure,
  deadline exceeded or invalid response. No sidecar fallback.
* UNREGISTERED: packet sender is not the launched process.
* STALE_GENERATION: a trusted resume superseded this channel's generation.
* REVOKED: trusted revocation on a still-open channel. Exit closes the channel,
  so subsequent client calls normally see UNAVAILABLE instead.
* CONFLICT: duplicate fresh registration or conflicting trusted launch data.
* UNSUPPORTED_VERSION: incompatible wire version.
* RESUME_REAUTH_REQUIRED: resume without this authority's retained trusted record.
* MALFORMED_REQUEST: invalid request framing/schema.

Only resolveSelf is exposed to workers. Issuance/resume/revocation are Python
supervisor methods, not wire operations. A worker cannot choose which identity
is resolved. Response validation includes correlation and strict schema checks.

This is connection-scoped live evidence, NOT a signed or transferable document.
Do not persist, replay, accept from a DM payload, or use it as a bearer token.
Resolve immediately before every cooperative send, history read or mailbox
selection; use ONLY returned persona/project/session/tuple. Refusal must produce
zero mailbox, history, watcher or grant effects. A response cannot make a later
filesystem write atomic with revocation; this API does not claim that property.

## Producer and lifecycle API

`launch_authority.py`: `Authority()` hardens the current supervisor process;
`launch(argv, binding)` issues a fresh record and starts a worker; `resume(argv,
childSessionId)` uses retained trusted fields and creates a new generation;
`revoke(childSessionId)` denies current use; `serve_once(timeout)` services live
packets and pidfds; `close()` revokes, kills only its still-pinned children and
reaps them. `AuthorityError.code` uses the error vocabulary above. argv must exec
the actual worker, not an intermediary shell spawning a different process.
The supervisor must keep servicing requests while workers run. FD 4 is explicitly
marked inheritable even when dup2 is a same-descriptor no-op (R3b regression).

Bounded probes and ordered failure/repair evidence live in
`verification/run-f241-launch-authority.py` and `docs/f241-r2-evidence.md`.
They exercise real Node processes and the native client, not full Pi or Herdr
integration. Inherited-descriptor rejection and authority-death fail-closed
behavior pass; independent Echo and durable test-suite registration remain pending.

Duplicate fresh child IDs refuse. Resume retains persona/project/child ID/parent
lineage/tuple and invalidates the previous channel. Original worker exit leaves
only trusted history in the live supervisor, permitting legitimate resume.
ParentSessionId describes lineage, not a liveness requirement: the original
parent may exit if the trusted supervisor remains alive. Supervisor loss closes
all channels. **Cold adoption after authority loss is unsupported pending trusted
reauthorization.** Starting a new authority and reading old session/sidecar files
is not reauthorization. There is no persistence/import/recovery API.

## F-246 trusted surface-resume amendment (partial)

`resume_surface(argv, childSessionId, surface)` accepts exactly the actual newly
allocated workspaceId/tabId/paneId from a trusted launcher. It services the sole
reaper and rejects CONFLICT until the previous session writer has exited and
been reaped; stable identity and original lineage remain unchanged, generation
advances, and absent retained history refuses RESUME_REAUTH_REQUIRED. Worker
resolveSelf cannot invoke it. The old `resume` primitive remains for F-241
stale-channel verification and must not be used by the production session-writer
adapter. This amendment is not yet wired to Herdr or the provider caller.

The build script now accepts an optional build-time staging directory. The native
artifact must be packaged beside the consumer module at its fixed relative
location; no runtime compilation or environment-selected module path is added.
See `docs/f246-evidence.md` for passing isolated probes and remaining work.

## Migration and remaining integration gap

Investigated legacy revision: 88837a8a7c95c38cb86e7f40125bf6bfd894edcf.
Local branch: task/f241-authenticated-launch-identity, based on
 d389aea21b91eb2f8cfbc30349d1633fc81b64e0. The local commit containing this document
is the implementation revision; no package version bump/release is implied.

Legacy `index.ts` sends a shell-script pathname into an already-created Herdr
pane. That API cannot transfer an inherited descriptor from the delegator into
the pane's existing shell. This implementation therefore supplies a real
supervised-launch API and consumer client, but does NOT silently turn the legacy
script/sidecar route into authenticated issuance. Integrating requires a trusted
Herdr/desktop process-spawn API with FD passing (or running this supervisor at
that trusted launch boundary). Fresh/resume legacy panes continue to have no v1
authority and must fail closed in Sula. This is a runtime-owner integration
blocker, not an assertion that root is necessary. No live pane changes were made.

Sula's compatibility bridge must feature-detect v1, call resolveSelf and deny if
unavailable; never fall back to spawn metadata. Remove the bridge only after the
runtime owner installs a compatible producer and Sula switches to the supported
API, or explicitly removes delegated DM support. Keep recovery metadata only for
UI/recovery, not authentication. A future incompatible contract increments v.

## Same-user mailbox gap / owner decision

A hostile worker can bypass a cooperative consumer and directly read/write any
mailbox or grant file writable by its UID. Attestation does not mediate those
files; assessing blame for direct file access is out of scope. The single owner
decision is whether to **accept the narrower cooperative-consumer guarantee** or
require mailbox access mediation using privilege separation/worker isolation.
The latter requires a protected service/filesystem policy; neither is installed
by this local fork lane.
