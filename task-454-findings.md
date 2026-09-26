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

(see bottom, appended as the lane runs)
