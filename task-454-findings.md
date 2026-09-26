# TASK-454 findings — cwd-less subagent spawn yields null paths[0]

Lane: deep, clone /home/kris/.pi/agent/git/github.com/fwhskr/pi-herdr-subagents,
branch fix/f255-throwing-continuation-containment (base 47310d5).

## Throw site (AC2)

- `node -e 'require("path").resolve(null)'` -> `The "paths[0]" argument must be of
  type string. Received null` (exact verbatim). `path.join(null)` says `"path"`,
  so the validator named `paths` is `path.resolve`.
- Only two `resolve(` path calls in pi-extension; the one reachable from spawn is
  `pi-extension/subagents/spawn-trust.ts:26` `canonicalizePath` -> `resolve(path)`.

## Data flow that yields null

1. `pi-extension/subagents/index.ts:629-644` `resolveSubagentPaths`:
   `rawCwd = params.cwd ?? agentDefs?.cwd ?? null` -> `effectiveCwd = null` when
   neither the call nor the profile declares a cwd.
2. `index.ts:2133-2134`: the launcher already knows the default
   (`targetCwdForSession = effectiveCwd ?? ctx.cwd`) but passes the raw null on.
3. `index.ts:2212` `driver.buildCommand({ effectiveCwd: null, parentCwd: ctx.cwd,
   parentTrusted: ctx.isProjectTrusted() })` — types.ts:44 declares
   `effectiveCwd: string`, so the null violates the driver contract.
4. `harness/drivers/pi.ts:124-128` `resolveSpawnTrustFlag({ childCwd: null, ... })`
   (added by ac03de5, 2026-09-21, B12 trust flag).
5. `spawn-trust.ts:95` (branch a: parentCwd + parentTrusted known — live pi ctx
   has isProjectTrusted) or `spawn-trust.ts:102 -> 50` (branch b: trust.json
   exists) -> `canonicalizePath(null)` -> `spawn-trust.ts:26 resolve(null)` throws.

Falsifiable: set `cwd` (or a profile `cwd:`) and childCwd is a string, no throw
(repro call 3). Other drivers (claude/codex/...) only use effectiveCwd in a
truthy `cd` prefix, so only the pi driver throws.

Why only some processes: every cwd-less pi-driver spawn on code >= ac03de5
throws; processes that loaded the extension earlier, or callers/profiles that
supply cwd, do not hit it. (Not independently verified per process.)

## Fix

Default the effective cwd at the shared source: `resolveSubagentPaths` takes the
parent session cwd (`ctx.cwd`) as the default, so a cwd-less call behaves
exactly like `cwd = <parent cwd>` (the launcher's existing session-dir default).

## Commands / results

All from the clone root, node v22 (`node --test`).

1. RED (base 47310d5 + fixture, commit 5f0f52e):
   `timeout 60 node --test test/task454-cwdless-spawn.test.ts` -> exit 1,
   `not ok 1 - cwd-less ...`, `error: 'The "paths[0]" argument must be of type
   string. Received null'`, `# pass 3 # fail 1` (the three controls already pass).
   Stack: `resolve (node:path:1272)` <- `canonicalizePath spawn-trust.ts:26:20`
   <- `resolveSpawnTrustFlag spawn-trust.ts:95:5` <- `PiHarnessDriver.buildCommand
   drivers/pi.ts:124:16` <- `launchSubagent index.ts:2201:24` <- `execute
   index.ts:3017:25`.
2. GREEN after fix: same command -> exit 0, `# pass 4 # fail 0 # skipped 0`.
3. Mutation (AC5): `const effectiveCwd = declaredCwd ?? defaultCwd;` ->
   `declaredCwd as string;` then
   `timeout 60 node --test --test-name-pattern="cwd-less" test/task454-cwdless-spawn.test.ts`
   -> exit 1, `error: "Cannot read properties of null (reading 'replace')"`
   (null now hits getDefaultSessionDirFor first, since the call site no longer
   re-defaults), `# fail 1`. Restored from copy: sha256 before and after
   `09afdb27ca9c349c3e28665c94fe78a5470bfc089cb664eb1777f19d31e9c723`, `cmp` exit 0;
   re-run GREEN exit 0, `# pass 4 # fail 0`.
4. Adjacent: `timeout 120 node --test test/harness-drivers.test.ts
   test/task450-resume-tools-allowlist.test.ts test/test.ts` -> exit 0,
   `# tests 273 # pass 273 # fail 0`.
5. Lint: `timeout 90 npx --no-install oxlint pi-extension/subagents/index.ts
   test/task454-cwdless-spawn.test.ts` -> exit 0.

## Design notes

- `localAgentDir` still derives only from a declared (call/profile) cwd, so a
  cwd-less call keeps the global agent dir as before; only the cwd is defaulted.
- The guard control imports the live
  /home/kris/.pi/agent/extensions/strict-agent-profiles.ts read-only (skipped
  when absent); the guard lives there, not in this clone, and is cwd-independent.

## Candidate findings (out of scope, not in the diff)

- `createSubagentPane` runs (index.ts ~2151) before `driver.buildCommand`; a
  buildCommand throw leaves a created pane with no launch. The recorded failures
  may have left empty panes; failure containment around buildCommand is not
  covered by this task.
- `harness/types.ts:44` declared `effectiveCwd: string` while index.ts passed
  `string | null`; no typecheck (no tsc in the repo) caught it.
