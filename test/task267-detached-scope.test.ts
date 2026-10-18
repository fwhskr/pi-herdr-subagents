import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { readFileSync, rmSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { bindVerifierScope, realEngineBinding } from "../pi-extension/subagents/verifier-scope.ts";

// TASK-267: launcher-authored detached bounded attempts. Imports only the schema module (no runtime/SDK deps).
const base = "/home/kris/.pi/agent/var/verifier-scope";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const MIB = 1024 * 1024; const GIB = 1024 * MIB;
function authorization() {
  const auth_id = `detached-${randomUUID()}`; roots.push(join(base, auth_id));
  return { schema: 1, auth_id, candidate: { repo_realpath: "/home/kris/.pi", commit_sha: "a".repeat(40) }, entries: [] as any[] };
}
const entry = (extra: Record<string, unknown> = {}) => ({ id: "d", cwd_realpath: "/home/kris/.pi", argv: [process.execPath, "-e", "0"], selector: "synthetic-detached",
  inputs: [], runtime_roots: [], read_roots: [], write_roots: [], env: {}, timeout_s: 600, max_attempts: 1, retry_on_failure: false, network: false,
  detached: { memory_max_bytes: 256 * MIB, pids_max: 128 }, ...extra });
const fence = (auth: unknown) => `\`\`\`verifier-scope\n${JSON.stringify(auth)}\n\`\`\``;
const bind = (auth: any, rawFence?: string) => {
  const binding = bindVerifierScope(rawFence ?? fence(auth), `session-${randomUUID()}`)!;
  roots.push(join(base, binding.auth_id)); return binding;
};
const published = (id: string) => JSON.parse(readFileSync(join(base, id, "authorization.json"), "utf8"));
const refused = (binding: { auth_id: string; error?: string }, reason: RegExp, why: string) => {
  assert.match(binding.error ?? "", reason, `${why}: ${binding.error}`);
  assert.deepEqual(published(binding.auth_id).entries, [], why);
};

it("publishes a detached entry verbatim as the launcher's immutable record with a 10..900s deadline", () => {
  const auth = authorization(); auth.entries.push(entry());
  const binding = bind(auth);
  assert.equal(binding.error, undefined); assert.equal(binding.auth_id, auth.auth_id);
  assert.deepEqual(published(auth.auth_id), auth);
  const file = join(base, auth.auth_id, "authorization.json"); const st = statSync(file);
  assert.equal(st.mode & 0o777, 0o444); assert.equal(st.nlink, 1);
  for (const [timeout_s, memory_max_bytes, pids_max] of [[10, 16 * MIB, 1], [900, 64 * GIB, 4096], [60, 16 * MIB + 1, 4095]]) {
    const edge = authorization(); edge.entries.push(entry({ timeout_s, detached: { memory_max_bytes, pids_max } }));
    assert.equal(bind(edge).error, undefined, `${timeout_s}/${memory_max_bytes}/${pids_max}`);
  }
});

it("reuses only the identical detached authorization and refuses changed ceilings or deadline under its identity", () => {
  const auth = authorization(); auth.entries.push(entry());
  assert.equal(bind(auth).error, undefined);
  assert.equal(bind(auth).error, undefined, "identical publication remains idempotent");
  for (const extra of [
    { detached: { memory_max_bytes: 512 * MIB, pids_max: 128 } },
    { detached: { memory_max_bytes: 256 * MIB, pids_max: 256 } },
    { timeout_s: 900 },
  ]) {
    const changed = { ...auth, entries: [entry(extra)] };
    refused(bind(changed), /Authorization id already bound/, "changed detached material input");
    assert.deepEqual(published(auth.auth_id), auth, "the original immutable record is untouched");
  }
  assert.equal(existsSync(join(base, auth.auth_id, "attempts")), false, "publication starts no attempt");
});

it("refuses every malformed, non-finite, out-of-range or widened detached request before publication", () => {
  type Case = [string, Record<string, unknown>, RegExp];
  const bad = (detached: unknown): Record<string, unknown> => ({ detached });
  const cases: Case[] = [
    ["memory below 16 MiB", bad({ memory_max_bytes: 16 * MIB - 1, pids_max: 8 }), /Invalid detached kernel ceilings/],
    ["memory above 64 GiB", bad({ memory_max_bytes: 64 * GIB + 1, pids_max: 8 }), /Invalid detached kernel ceilings/],
    ["memory zero", bad({ memory_max_bytes: 0, pids_max: 8 }), /Invalid detached kernel ceilings/],
    ["memory negative", bad({ memory_max_bytes: -1, pids_max: 8 }), /Invalid detached kernel ceilings/],
    ["memory fractional", bad({ memory_max_bytes: 16 * MIB + 0.5, pids_max: 8 }), /Invalid detached kernel ceilings/],
    ["memory string", bad({ memory_max_bytes: "33554432", pids_max: 8 }), /Invalid detached kernel ceilings/],
    ["memory null", bad({ memory_max_bytes: null, pids_max: 8 }), /Invalid detached kernel ceilings/],
    ["memory missing", bad({ pids_max: 8 }), /Invalid detached kernel ceilings/],
    ["memory 'max' (no ceiling)", bad({ memory_max_bytes: "max", pids_max: 8 }), /Invalid detached kernel ceilings/],
    ["memory boolean", bad({ memory_max_bytes: true, pids_max: 8 }), /Invalid detached kernel ceilings/],
    ["pids zero", bad({ memory_max_bytes: 64 * MIB, pids_max: 0 }), /Invalid detached kernel ceilings/],
    ["pids negative", bad({ memory_max_bytes: 64 * MIB, pids_max: -1 }), /Invalid detached kernel ceilings/],
    ["pids null", bad({ memory_max_bytes: 64 * MIB, pids_max: null }), /Invalid detached kernel ceilings/],
    ["pids boolean", bad({ memory_max_bytes: 64 * MIB, pids_max: true }), /Invalid detached kernel ceilings/],
    ["pids above 4096", bad({ memory_max_bytes: 64 * MIB, pids_max: 4097 }), /Invalid detached kernel ceilings/],
    ["pids fractional", bad({ memory_max_bytes: 64 * MIB, pids_max: 1.5 }), /Invalid detached kernel ceilings/],
    ["pids string", bad({ memory_max_bytes: 64 * MIB, pids_max: "8" }), /Invalid detached kernel ceilings/],
    ["pids 'max' (no ceiling)", bad({ memory_max_bytes: 64 * MIB, pids_max: "max" }), /Invalid detached kernel ceilings/],
    ["pids missing", bad({ memory_max_bytes: 64 * MIB }), /Invalid detached kernel ceilings/],
    ["extra detached field", bad({ memory_max_bytes: 64 * MIB, pids_max: 8, cpu_max: 1 }), /Unknown authorization field/],
    ["detached null", bad(null), /Invalid detached authorization/],
    ["detached array", bad([64 * MIB, 8]), /Invalid detached authorization/],
    ["detached true", bad(true), /Invalid detached authorization/],
    ["detached empty", bad({}), /Invalid detached kernel ceilings/],
    ["detached with self-test", { runner_self_test: {} }, /Invalid detached authorization/],
    ["detached deadline 9", { timeout_s: 9 }, /Invalid detached overall deadline/],
    ["detached deadline 901", { timeout_s: 901 }, /Invalid detached overall deadline/],
    ["detached deadline 0", { timeout_s: 0 }, /Invalid detached overall deadline/],
    ["detached deadline fractional", { timeout_s: 10.5 }, /Invalid detached overall deadline/],
    ["detached deadline string", { timeout_s: "600" }, /Invalid detached overall deadline/],
    ["detached deadline null", { timeout_s: null }, /Invalid detached overall deadline/],
    ["detached retry", { retry_on_failure: true }, /no-retry/],
    ["detached network", { network: true }, /offline/],
    ["detached many attempts", { max_attempts: 2 }, /Only once/],
  ];
  for (const [name, extra, reason] of cases) {
    const auth = authorization(); auth.entries.push(entry(extra));
    refused(bind(auth), reason, name);
    assert.equal(existsSync(join(base, auth.auth_id)), false, name);
  }
  // JSON cannot carry NaN/Infinity: they serialize to null and must still be refused (also as raw literals).
  for (const literal of ["NaN", "Infinity", "-Infinity", "1e999"]) {
    const auth = authorization(); auth.entries.push(entry());
    const text = JSON.stringify(auth).replace('"memory_max_bytes":268435456', `"memory_max_bytes":${literal}`);
    assert.ok(text.includes(literal));
    refused(bind(auth, `\`\`\`verifier-scope\n${text}\n\`\`\``), /./, `memory literal ${literal}`);
    const pidsText = JSON.stringify(auth).replace('"pids_max":128', `"pids_max":${literal}`);
    refused(bind(auth, `\`\`\`verifier-scope\n${pidsText}\n\`\`\``), /./, `pids literal ${literal}`);
    const timeoutText = JSON.stringify(auth).replace('"timeout_s":600', `"timeout_s":${literal}`);
    refused(bind(auth, `\`\`\`verifier-scope\n${timeoutText}\n\`\`\``), /./, `deadline literal ${literal}`);
  }
  const nonFinite = authorization(); nonFinite.entries.push(entry({ detached: { memory_max_bytes: Number.NaN, pids_max: Number.POSITIVE_INFINITY } }));
  refused(bind(nonFinite), /Invalid detached kernel ceilings/, "NaN/Infinity serialize to null");
});

it("never widens the ordinary entry: the 60s bound and the unknown-field rule stay, detached is not implied", () => {
  for (const timeout_s of [0, -1, 1.5, 61, 600, 900, 901, Number.NaN, Number.POSITIVE_INFINITY]) {
    const auth = authorization(); const { detached: _d, ...ordinary } = entry({ timeout_s });
    auth.entries.push(ordinary);
    refused(bind(auth), /Invalid timeout \(1\.\.60 seconds\)/, `ordinary ${timeout_s}`);
  }
  const small = authorization(); const { detached: _d, ...ordinary } = entry({ timeout_s: 60 });
  small.entries.push(ordinary); assert.equal(bind(small).error, undefined);
  const lower = authorization(); lower.entries.push(entry({ timeout_s: 1, detached: undefined }));
  assert.equal(bind(lower).error, undefined, "ordinary 1s still valid");
  // A detached deadline is not accepted for a non-detached record via key renaming.
  const alias = authorization(); alias.entries.push({ ...ordinary, timeout_s: 600, detach: { memory_max_bytes: 64 * MIB, pids_max: 8 } });
  refused(bind(alias), /Unknown authorization field/, "alias key");
  // No detached key anywhere else in the authorization.
  const top = authorization(); (top as any).detached = { memory_max_bytes: 64 * MIB, pids_max: 8 };
  refused(bind(top), /Unknown authorization field/, "top-level detached");
});

// Runtime oracle: select a frozen candidate via the environment when testing an uninstalled pair.
// This loads only the real schema/runner module; no service, fixture or attempt is started.
const ORACLE = process.env.PI_VERIFIER_RUNNER_ORACLE ?? "/home/kris/.pi/agent/extensions/verifier-scoped-runner.ts";
async function runtimeOracle(): Promise<any> {
  return import(pathToFileURL(ORACLE).href);
}
const engineEntry = (detached?: { memory_max_bytes: number; pids_max: number }) => ({
  id: "engine", cwd_realpath: "/home/kris/.pi", argv: ["/usr/bin/podman", "info"], selector: "synthetic-engine", inputs: ["/in"], runtime_roots: [] as string[],
  read_roots: [] as string[], write_roots: ["/out"], env: { A: "b" }, timeout_s: detached ? 120 : 60, max_output_bytes: 4096, max_attempts: 1, retry_on_failure: false, network: false,
  ...(detached ? { detached } : {}),
  real_engine: { storage_root: "/s", engine_pins: { "/usr/bin/podman": "1".repeat(64) }, input_pins: { "/in": "2".repeat(64) }, binding: "" } });
const sealAuth = { auth_id: "binding-fixture", candidate: { repo_realpath: "/home/kris/.pi", commit_sha: "b".repeat(40) } };

it("binds a detached engine entry by appending exactly ['detached', memory, pids]; non-detached bindings are unchanged", async () => {
  const plain: any = engineEntry(); const det: any = engineEntry({ memory_max_bytes: 512 * MIB, pids_max: 64 });
  const p = realEngineBinding(sealAuth, plain); const d = realEngineBinding(sealAuth, det);
  assert.match(d, /^[a-f0-9]{64}$/); assert.notEqual(p, d);
  // Any change to either ceiling or the deadline re-binds.
  for (const mutate of [(e: any) => { e.detached.memory_max_bytes += 1; }, (e: any) => { e.detached.pids_max += 1; }, (e: any) => { e.timeout_s += 1; }]) {
    const e: any = engineEntry({ memory_max_bytes: 512 * MIB, pids_max: 64 }); mutate(e);
    assert.notEqual(realEngineBinding(sealAuth, e), d);
  }
  const runtime = await runtimeOracle();
  assert.equal(p, runtime.realEngineBinding(sealAuth, plain), "ordinary engine binding matches the runtime");
  assert.equal(d, runtime.realEngineBinding(sealAuth, det), "detached engine binding matches the runtime exactly");
});

it("the real runtime loads the launcher-published detached record (no attempt started)", async () => {
  const runtime = await runtimeOracle();
  const auth = authorization(); auth.entries.push(entry());
  assert.equal(bind(auth).error, undefined);
  assert.deepEqual(runtime.createScopedRunner(auth.auth_id).ids, ["d"]);
  assert.equal(existsSync(join(base, auth.auth_id, "attempts")), false, "loading reserves nothing");
});
