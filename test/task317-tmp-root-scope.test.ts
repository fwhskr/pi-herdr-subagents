import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { bindVerifierScope, realEngineBinding } from "../pi-extension/subagents/verifier-scope.ts";

// TASK-317: optional caller-declared tmp_root. Structural schema only; the runtime owns canonical containment in cwd.
const base = "/home/kris/.pi/agent/var/verifier-scope";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const MIB = 1024 * 1024;
function authorization() {
  const auth_id = `tmproot-${randomUUID()}`; roots.push(join(base, auth_id));
  return { schema: 1, auth_id, candidate: { repo_realpath: "/home/kris/.pi", commit_sha: "a".repeat(40) }, entries: [] as any[] };
}
const entry = (extra: Record<string, unknown> = {}) => ({ id: "t", cwd_realpath: "/home/kris/.pi", argv: [process.execPath, "-e", "0"], selector: "synthetic-tmp-root",
  inputs: [], runtime_roots: [], read_roots: [], write_roots: ["/home/kris/.pi/work", "/home/kris/.pi/other"], env: {}, timeout_s: 30, max_attempts: 1, retry_on_failure: false, network: false, ...extra });
const bind = (auth: any) => {
  const binding = bindVerifierScope(`\`\`\`verifier-scope\n${JSON.stringify(auth)}\n\`\`\``, `session-${randomUUID()}`)!;
  roots.push(join(base, binding.auth_id)); return binding;
};
const published = (id: string) => JSON.parse(readFileSync(join(base, id, "authorization.json"), "utf8"));
const refused = (auth: any, reason: RegExp, why: string) => {
  const b = bind(auth);
  assert.match(b.error ?? "", reason, `${why}: ${b.error}`);
  assert.deepEqual(published(b.auth_id).entries, [], why);
};

it("publishes a tmp_root that is an exact write_roots member verbatim, for ordinary and detached entries", () => {
  const ordinary = authorization(); ordinary.entries.push(entry({ tmp_root: "/home/kris/.pi/work" }));
  const b = bind(ordinary); assert.equal(b.error, undefined);
  assert.deepEqual(published(ordinary.auth_id), ordinary);
  const detached = authorization(); detached.entries.push(entry({ tmp_root: "/home/kris/.pi/other", timeout_s: 900, detached: { memory_max_bytes: 256 * MIB, pids_max: 64 } }));
  assert.equal(bind(detached).error, undefined);
  assert.deepEqual(published(detached.auth_id), detached);
  const none = authorization(); none.entries.push(entry());
  assert.equal(bind(none).error, undefined);
  assert.equal("tmp_root" in published(none.auth_id).entries[0], false, "key absent unless declared");
});

it("refuses a malformed, non-member or real-engine tmp_root before publication", () => {
  const cases: [string, Record<string, unknown>][] = [
    ["number", { tmp_root: 7 }], ["null", { tmp_root: null }], ["array", { tmp_root: ["/home/kris/.pi/work"] }], ["object", { tmp_root: {} }], ["empty write_roots", { tmp_root: "/home/kris/.pi/work", write_roots: [] }],
    ["not a member", { tmp_root: "/home/kris/.pi/elsewhere" }], ["trailing slash alias", { tmp_root: "/home/kris/.pi/work/" }], ["NUL", { tmp_root: "/home/kris/.pi/work\0", write_roots: ["/home/kris/.pi/work\0"] }],
    ["child of member", { tmp_root: "/home/kris/.pi/work/sub" }],
    ["real engine", { tmp_root: "/home/kris/.pi/work", argv: ["/usr/bin/podman", "info"], real_engine: { engine_pins: { "/usr/bin/podman": "1".repeat(64) }, input_pins: { "/in": "2".repeat(64) } } }],
  ];
  for (const [why, extra] of cases) { const a = authorization(); a.entries.push(entry(extra)); refused(a, /Invalid tmp_root|Invalid roots/, why); }
});

it("keeps the detached 10..900s deadline and the ordinary 1..60s bound with tmp_root present", () => {
  for (const timeout_s of [10, 600, 900]) {
    const a = authorization(); a.entries.push(entry({ tmp_root: "/home/kris/.pi/work", timeout_s, detached: { memory_max_bytes: 64 * MIB, pids_max: 8 } }));
    assert.equal(bind(a).error, undefined, `detached ${timeout_s}`);
  }
  for (const timeout_s of [9, 901]) {
    const a = authorization(); a.entries.push(entry({ tmp_root: "/home/kris/.pi/work", timeout_s, detached: { memory_max_bytes: 64 * MIB, pids_max: 8 } }));
    refused(a, /Invalid detached overall deadline/, `detached ${timeout_s}`);
  }
  for (const timeout_s of [61, 600]) { const a = authorization(); a.entries.push(entry({ tmp_root: "/home/kris/.pi/work", timeout_s })); refused(a, /Invalid timeout/, `ordinary ${timeout_s}`); }
  const ok = authorization(); ok.entries.push(entry({ tmp_root: "/home/kris/.pi/work", timeout_s: 60 }));
  assert.equal(bind(ok).error, undefined);
});

it("excludes tmp_root from the engine binding and leaves existing bindings unchanged", async () => {
  const sealAuth = { auth_id: "binding-fixture", candidate: { repo_realpath: "/home/kris/.pi", commit_sha: "b".repeat(40) } };
  const eng = (extra: Record<string, unknown> = {}): any => ({ id: "engine", cwd_realpath: "/home/kris/.pi", argv: ["/usr/bin/podman", "info"], selector: "s", inputs: ["/in"], runtime_roots: [],
    read_roots: [], write_roots: ["/out"], env: { A: "b" }, timeout_s: 60, max_output_bytes: 4096, max_attempts: 1, retry_on_failure: false, network: false,
    real_engine: { storage_root: "/s", engine_pins: { "/usr/bin/podman": "1".repeat(64) }, input_pins: { "/in": "2".repeat(64) }, binding: "" }, ...extra });
  assert.equal(realEngineBinding(sealAuth, eng({ tmp_root: "/out" })), realEngineBinding(sealAuth, eng()), "tmp_root does not enter the binding");
  const oracle = process.env.PI_VERIFIER_RUNNER_ORACLE ?? "/home/kris/.pi/agent/extensions/verifier-scoped-runner.ts";
  const runtime = await import(pathToFileURL(oracle).href);
  assert.equal(realEngineBinding(sealAuth, eng()), runtime.realEngineBinding(sealAuth, eng()), "matches the runtime for an entry without tmp_root");
});
