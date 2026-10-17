import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { processIdentity } from "../scratch-lifecycle.ts";
import { prepareLaunchScript, runScriptInPane } from "../terminal.ts";
import {
  armDispatchDeadline, canonicalProject, cancelLaunchStorage, DESCRIPTOR_NAME, EVENTS_NAME, reserveLaunchStorage,
  settleLaunchStorage, settleMeta, STORAGE_BUDGET_CLI, StorageRefusal, writeAdoptDescriptor,
} from "../storage-admission.ts";

// TASK-283: terminal launch preparation reserves a pending handoff lease through the standalone
// storage-budget CLI before any scratch, then hands the pane's foreground job to the core
// (`run --attach job --request-fd 3`). A synthetic double covers only pre-dispatch and transport
// behavior; everything after dispatch runs against the REAL CLI on an isolated registry.
const fixtures = "/home/kris/.pi/agent/var/TASK-283/rescue/fixtures";
const MiB = 1024 ** 2;
// Test-only seam for the real core under test (TASK-292 `run --attach job`). Unset = the production
// constant, which is never edited here; the production path activates only when the core lands on main.
const CORE_UNDER_TEST = process.env.TASK283_STORAGE_CORE_CLI ?? STORAGE_BUDGET_CLI;

interface Call { op: string; req: Record<string, any>; argv: string[]; baseExists: boolean }

function fixture() {
  mkdirSync(fixtures, { recursive: true });
  const root = realpathSync(mkdtempSync(join(fixtures, "case-")));
  const base = join(root, "leases");
  const log = join(root, "calls.jsonl");
  const modeFile = join(root, "mode");
  writeFileSync(modeFile, "admit");
  const cli = join(root, "storage-budget.mjs");
  writeFileSync(cli, `
import { appendFileSync, existsSync, readFileSync } from "node:fs";
const op = process.argv[2];
const req = JSON.parse(readFileSync(0, "utf8") || "{}");
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ op, req, argv: process.argv.slice(3), baseExists: existsSync(${JSON.stringify(base)}) }) + "\\n");
const mode = readFileSync(${JSON.stringify(modeFile)}, "utf8").trim();
const out = (value) => process.stdout.write(JSON.stringify({ production: true, ...value }) + "\\n");
if (mode === "hang") setTimeout(() => {}, 60000);
else if (mode === "garbage") process.stdout.write("not json");
else if (mode === "exit3") process.exit(3);
else if (op === "reserve" && mode === "deny") { out({ ok: true, admitted: false, reason: "insufficient-space", freeBytes: 1000, reservedBytes: 500, estimatedBytes: 2048, remainingBytes: -1, floorBytes: 99 }); process.exit(1); }
else if (op === "reserve" && mode === "nolease") out({ ok: true, admitted: true });
else if (op === "reserve" && mode === "isolated") out({ ok: true, admitted: true, leaseId: "x", production: false });
else if (op === "reserve") out({ ok: true, admitted: true, reason: "admitted", handoff: "pending", leaseId: "lease-" + req.launchId, freeBytes: 100, reservedBytes: 0, estimatedBytes: 2048, remainingBytes: 1, floorBytes: 1 });
else if (op === "status" && mode === "pending") out({ ok: true, query: "lease", leaseState: "present", projectMatches: true, lease: { dispatched: false, handoff: "pending" } });
else if (op === "status" && mode === "dispatched") out({ ok: true, query: "lease", leaseState: "present", projectMatches: true, lease: { dispatched: true, handoff: "bound" } });
else if (op === "status") out({ ok: true, query: "lease", leaseState: "unknown", lease: null });
else if (op === "release" && mode === "failrelease") process.exit(3);
else if (op === "release" && (mode === "pending" || mode === "admit")) out({ ok: true, admitted: true, released: true, reason: req.reason, leaseId: req.leaseId });
else if (op === "release" && mode === "notfound") { out({ ok: true, admitted: false, reason: "lease-not-found" }); }
else if (op === "release") { out({ ok: true, admitted: false, released: false, reason: "liveness-preserved" }); process.exit(1); }
else out({ ok: false, reason: "invalid-request" });
`);
  return {
    root, base, cli,
    mode: (value: string) => writeFileSync(modeFile, value),
    calls: (): Call[] => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []),
    done: () => rmSync(root, { recursive: true, force: true }),
  };
}

const bootId = () => readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
const digest = (token: string) => `sha256:${createHash("sha256").update(Buffer.from(token, "hex")).digest("hex")}`;

test("low space, unreadable, malformed or wrong-registry ledger refuse before any scratch, script or transport", () => {
  const f = fixture();
  try {
    f.mode("deny");
    const scriptPath = join(f.root, "launch.sh");
    assert.throws(() => prepareLaunchScript("true", { scratchBase: f.base, scriptPath, storage: { cli: f.cli } }), (error: unknown) => {
      assert.ok(error instanceof StorageRefusal);
      assert.match(error.message, /insufficient-space/);
      assert.match(error.message, /free 1000 reserved 500 request 2048 floor 99/);
      assert.ok(error.message.length <= 600);
      return true;
    });
    assert.throws(() => runScriptInPane("pane-x", "true", { scratchBase: f.base, scriptPath, storage: { cli: f.cli } }), StorageRefusal);
    for (const mode of ["garbage", "exit3", "nolease", "hang", "isolated"]) {
      f.mode(mode);
      assert.throws(() => prepareLaunchScript("true", { scratchBase: f.base, scriptPath, storage: { cli: f.cli, timeoutMs: 500 } }), StorageRefusal, mode);
    }
    f.mode("admit");
    assert.throws(() => prepareLaunchScript("true", { scratchBase: f.base, scriptPath, storage: { cli: join(f.root, "missing.mjs") } }), StorageRefusal);
    assert.throws(() => prepareLaunchScript("true", { scratchBase: f.base, scriptPath, storage: { cli: f.cli, readBootId: () => null } }), /boot/i);
    assert.throws(() => prepareLaunchScript("true", { scratchBase: f.base, scriptPath, storage: { cli: f.cli, identity: () => undefined } }), StorageRefusal);
    assert.throws(() => prepareLaunchScript("true", { scratchBase: f.base, scriptPath, storage: { cli: f.cli, policy: "/x/policy.json" } }), StorageRefusal);
    // A production-default admission must come from the central registry; an isolated answer is refused.
    f.mode("isolated");
    assert.throws(() => reserveLaunchStorage(f.base, { cli: f.cli, project: "/home/kris/.pi" }), /unexpected registry/);
    assert.equal(existsSync(f.base), false, "no scratch base or lease may be created");
    assert.equal(existsSync(scriptPath), false);
    assert.ok(f.calls().every((call) => call.op === "reserve"));
  } finally { f.done(); }
});

test("permitted launch reserves a pending handoff before scratch and hands the foreground job to the core", () => {
  const f = fixture();
  try {
    const sessionFile = join(f.root, "session.jsonl");
    const launch = prepareLaunchScript("true", {
      scratchBase: f.base, scriptPath: join(f.root, "launch.sh"), scriptPreamble: `# Session: ${sessionFile}`,
      storage: { cli: f.cli, project: "/home/kris/.pi" },
    });
    const [reserve, ...rest] = f.calls();
    assert.equal(reserve.op, "reserve");
    assert.deepEqual(reserve.argv, [], "production takes no flags");
    assert.equal(reserve.baseExists, false, "lease acquired before scratch allocation");
    assert.deepEqual(rest, []);
    assert.deepEqual(Object.keys(reserve.req).sort(), ["class", "destination", "handoffDigest", "launchId", "producer", "project"]);
    assert.equal(reserve.req.destination, f.root);
    assert.equal(reserve.req.project, "/home/kris/.pi");
    assert.equal(reserve.req.class, "source");
    assert.deepEqual(reserve.req.producer, { pid: process.pid, startTime: processIdentity(process.pid), bootId: bootId() });

    const launchRoot = dirname(launch.scratch.leasePath);
    const descriptor = join(launchRoot, DESCRIPTOR_NAME);
    assert.equal(statSync(descriptor).mode & 0o777, 0o600);
    const adopt = JSON.parse(readFileSync(descriptor, "utf8"));
    assert.deepEqual(Object.keys(adopt).sort(), ["handoff", "launchId", "leaseId", "ownedPaths", "project"]);
    assert.equal(adopt.leaseId, launch.storage.leaseId);
    assert.deepEqual(adopt.ownedPaths, [launch.scratch.scratchRoot]);
    assert.deepEqual(adopt.handoff.from, reserve.req.producer);
    assert.match(adopt.handoff.token, /^[0-9a-f]{64}$/);
    assert.equal(reserve.req.handoffDigest, digest(adopt.handoff.token));

    const script = readFileSync(launch.scriptPath, "utf8");
    assert.equal(script.includes(adopt.handoff.token), false, "token never in the script, argv or environment");
    assert.equal(JSON.stringify(launch.storage).includes(adopt.handoff.token), false);
    assert.equal(readdirSync(launch.scratch.scratchRoot).includes(DESCRIPTOR_NAME), false, "descriptor not in TMPDIR");
    const runLine = script.split("\n").find((line) => line.includes("'--attach' 'job'"));
    assert.ok(runLine, "core run line present");
    assert.ok(runLine.startsWith(`'${process.execPath}' '${f.cli}' 'run' '--attach' 'job' '--request-fd' '3' '--event-file' '${join(launchRoot, EVENTS_NAME)}' '--' 'bash' '${join(launch.scratch.scratchRoot, "worker.sh")}' 3< '${descriptor}'`));
    assert.doesNotMatch(runLine, /^exec |&\s*$/, "foreground, not exec or background");
    assert.doesNotMatch(script, /--storage-admission' bind|phase/);
  } finally { f.done(); }
});

test("preparation and transport failures cancel only with the token, without producer authority", () => {
  const f = fixture();
  try {
    const obstruction = join(f.root, "obstruction");
    writeFileSync(obstruction, "file");
    assert.throws(() => prepareLaunchScript("true", { scratchBase: f.base, scriptPath: join(obstruction, "launch.sh"), storage: { cli: f.cli } }));
    let calls = f.calls();
    assert.deepEqual(calls.map((call) => call.op), ["reserve", "release"]);
    assert.deepEqual(Object.keys(calls[1].req).sort(), ["launchId", "leaseId", "project", "reason", "token"]);
    assert.equal(calls[1].req.reason, "cancelled-before-dispatch");
    assert.equal(calls[0].req.handoffDigest, digest(calls[1].req.token));
    assert.deepEqual(readdirSync(f.base).map((id) => existsSync(join(f.base, id, "scratch"))), [false]);

    assert.throws(() => runScriptInPane("pane-x", "true", { scratchBase: f.base, scriptPath: join(f.root, "pane.sh"), storage: { cli: f.cli } }), /herdr/i);
    calls = f.calls().slice(2);
    assert.deepEqual(calls.map((call) => call.op), ["reserve", "release"]);
    assert.equal(calls[1].req.reason, "cancelled-before-dispatch");
    assert.equal(calls[0].req.handoffDigest, digest(calls[1].req.token));
  } finally { f.done(); }
});

test("an unconfirmed cancel never throws and reports the reservation as kept", () => {
  const f = fixture();
  try {
    const lease = reserveLaunchStorage(f.base, { cli: f.cli, project: "/home/kris/.pi" });
    for (const mode of ["failrelease", "garbage", "preserve"]) {
      f.mode(mode);
      assert.equal(cancelLaunchStorage(lease), false, mode);
    }
    f.mode("admit");
    assert.equal(cancelLaunchStorage(lease), true);
  } finally { f.done(); }
});

test("pre-dispatch settlement follows core answers and keeps the token while unconfirmed", () => {
  const f = fixture();
  try {
    const lease = reserveLaunchStorage(f.base, { cli: f.cli, project: "/home/kris/.pi" });
    const root = join(f.root, "launch");
    mkdirSync(root);
    const descriptor = () => {
      rmSync(join(root, DESCRIPTOR_NAME), { force: true });
      return writeAdoptDescriptor(lease, join(root, "lease.json"), join(root, "scratch"));
    };
    let path = descriptor();
    f.mode("garbage");
    assert.equal(settleLaunchStorage(settleMeta(lease), path, 0), "retained");
    assert.equal(existsSync(path), true, "token kept while the core is indeterminate");
    f.mode("admit");
    assert.equal(settleLaunchStorage(settleMeta(lease), path, 0), "cancelled");
    assert.equal(existsSync(path), false);
    path = descriptor();
    f.mode("notfound");
    assert.equal(settleLaunchStorage(settleMeta(lease), path, 0), "gone");
    path = descriptor();
    f.mode("preserve");
    assert.equal(settleLaunchStorage(settleMeta(lease), path, 0), "retained", "never released without core confirmation");
    assert.equal(f.calls().filter((call) => call.op === "release" && call.req.reason !== "cancelled-before-dispatch").length, 0);
    assert.ok(f.calls().filter((call) => call.op === "release").every((call) => call.req.token && !("producer" in call.req)));
  } finally { f.done(); }
});

test("one dispatch deadline cancels a never-bound pending lease with the token and leaves a bound one alone", async () => {
  const f = fixture();
  // The production timer is unref'd (never holds the extension open); hold this test's loop instead.
  const hold = setInterval(() => {}, 1000);
  try {
    const pending = reserveLaunchStorage(f.base, { cli: f.cli, project: "/home/kris/.pi" });
    f.mode("pending");
    assert.equal(await armDispatchDeadline(pending, 10), "cancelled");
    const release = f.calls().filter((call) => call.op === "release");
    assert.equal(release.length, 1);
    assert.equal(release[0].req.reason, "cancelled-before-dispatch");
    assert.equal(f.calls()[0].req.handoffDigest, digest(release[0].req.token));

    f.mode("admit");
    const bound = reserveLaunchStorage(f.base, { cli: f.cli, project: "/home/kris/.pi" });
    f.mode("dispatched");
    const before = f.calls().length;
    assert.equal(await armDispatchDeadline(bound, 10), "dispatched");
    assert.deepEqual(f.calls().slice(before).map((call) => call.op), ["status"], "a bound job is never cancelled");
  } finally { clearInterval(hold); f.done(); }
});

test("project identity resolves worktrees and aliases to one canonical repository", () => {
  const f = fixture();
  try {
    const repo = join(f.root, "repo");
    const work = join(repo, ".worktrees", "lane");
    mkdirSync(join(repo, ".git", "worktrees", "lane"), { recursive: true });
    mkdirSync(join(work, "sub"), { recursive: true });
    writeFileSync(join(repo, ".git", "worktrees", "lane", "commondir"), "../..\n");
    writeFileSync(join(work, ".git"), `gitdir: ${join(repo, ".git", "worktrees", "lane")}\n`);
    assert.equal(canonicalProject(join(work, "sub")), repo);
    assert.equal(canonicalProject(repo), repo);
  } finally { f.done(); }
});

// ---- Real storage-budget CLI (isolated registry + standalone policy) inside a real PTY ----
// These need the core's `run --attach job --request-fd 3 --event-file` (TASK-292). Until it lands
// they fail: that is the integration blocker, never stubbed.
function realLedger() {
  mkdirSync(fixtures, { recursive: true });
  const root = realpathSync(mkdtempSync(join(fixtures, "real-")));
  const registryRoot = join(root, "registry");
  const policy = join(root, "policy.json");
  writeFileSync(policy, JSON.stringify({
    version: 1, headroomMinBytes: 1, headroomPercent: 0, projectCapBytes: 2 * MiB,
    estimates: { source: MiB }, monitorIntervalMs: 100, stopGraceMs: 500,
  }), { mode: 0o600 });
  const storage = { registryRoot, policy, project: "/home/kris/.pi", cli: CORE_UNDER_TEST };
  const status = (leaseId: string) => JSON.parse(execFileSync(process.execPath, [CORE_UNDER_TEST, "status", "--registry-root", registryRoot], {
    input: JSON.stringify({ leaseId, project: "/home/kris/.pi" }), encoding: "utf8", timeout: 10000,
  }));
  return { root, base: join(root, "leases"), storage, status, done: () => rmSync(root, { recursive: true, force: true }) };
}

function inPty(scriptPath: string, timeout = 15000): number {
  // `script` gives the launch a real pseudo-terminal and foreground job, as the herdr pane does.
  try { execFileSync("script", ["-qec", `bash ${scriptPath}`, "/dev/null"], { timeout, stdio: ["ignore", "ignore", "ignore"] }); return 0; }
  catch (error) { return (error as { status: number }).status; }
}

const events = (launch: { scratch: { leasePath: string } }) => {
  const path = join(dirname(launch.scratch.leasePath), EVENTS_NAME);
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
};

test("the worker keeps the pane terminal: tty stdin/stdout, foreground job control and resize SIGWINCH", () => {
  const r = realLedger();
  try {
    const out = join(r.root, "tty.out");
    const worker = [
      `trap 'echo winch >> ${out}' WINCH`,
      `[ -t 0 ] && echo stdin-tty >> '${out}'`,
      `[ -t 1 ] && echo stdout-tty >> '${out}'`,
      `read pg tp < <(ps -o pgid=,tpgid= -p $$); [ "$pg" = "$tp" ] && echo foreground >> '${out}'`,
      // TIOCSWINSZ on the controlling tty signals only its foreground process group.
      "stty cols 101 rows 31 </dev/tty; sleep 0.3; true",
    ].join("\n");
    const launch = prepareLaunchScript(worker, { scratchBase: r.base, scriptPath: join(r.root, "launch.sh"), storage: r.storage });
    assert.equal(launch.storage.production, false);
    assert.equal(inPty(launch.scriptPath), 0);
    assert.deepEqual(readFileSync(out, "utf8").trim().split("\n"), ["stdin-tty", "stdout-tty", "foreground", "winch"]);
    assert.ok(events(launch).some((event) => event.event === "started"), "core bound and started the worker");
    assert.equal(r.status(launch.storage.leaseId).leaseState, "absent", "settled after a clean exit");
    assert.equal(existsSync(join(dirname(launch.scratch.leasePath), DESCRIPTOR_NAME)), false, "descriptor removed");
  } finally { r.done(); }
});

test("owned output growth is reported to the shared ledger while the worker runs", () => {
  const r = realLedger();
  try {
    const seen = join(r.root, "mid-run-status.json");
    // The worker reads its lease id from a file the test writes after preparation.
    const query = `${JSON.stringify(process.execPath)} ${JSON.stringify(CORE_UNDER_TEST)} status --registry-root ${JSON.stringify(r.storage.registryRoot)}`;
    const worker = [
      `head -c ${MiB} /dev/zero > "$TMPDIR/grown"; sync; sleep 1`,
      `printf '{"leaseId":"%s","project":"/home/kris/.pi"}' "$(cat "$(dirname "$TMPDIR")/test-lease-id")" | ${query} > '${seen}'`,
    ].join("\n");
    const launch = prepareLaunchScript(worker, { scratchBase: r.base, scriptPath: join(r.root, "launch.sh"), storage: r.storage });
    writeFileSync(join(dirname(launch.scratch.leasePath), "test-lease-id"), launch.storage.leaseId);
    assert.equal(inPty(launch.scriptPath), 0);
    const mid = JSON.parse(readFileSync(seen, "utf8"));
    assert.equal(mid.leaseState, "present");
    assert.equal(mid.lease.dispatched, true);
    assert.ok(BigInt(mid.lease.consumedBytes) >= BigInt(MiB), `consumedBytes ${mid.lease.consumedBytes}`);
    assert.ok(events(launch).some((event) => event.event === "grow" && event.admitted === true), "estimate grown within the cap");
    assert.equal(r.status(launch.storage.leaseId).leaseState, "absent");
  } finally { r.done(); }
});

test("refused growth stops only the owned worker tree and never releases it as completed", () => {
  const r = realLedger();
  const finished = join(r.root, "finished");
  const bystander = execFileSync("bash", ["-c", "setsid sleep 30 >/dev/null 2>&1 & echo $!"], { encoding: "utf8" }).trim();
  try {
    const launch = prepareLaunchScript(`head -c ${4 * MiB} /dev/zero > "$TMPDIR/grown"; sync; sleep 6; touch '${finished}'`, {
      scratchBase: r.base, scriptPath: join(r.root, "launch.sh"), storage: r.storage,
    });
    const status = inPty(launch.scriptPath);
    // Promptness is proven by ordering, not a wall-clock bound (host I/O stalls distort timing): the worker
    // touches `finished` only after its own sleep, so its absence plus the real budget-stop event proves the stop came first.
    assert.equal(status, 75, "budget stop exit status");
    assert.equal(existsSync(finished), false, "worker production stopped before its own completion");
    assert.doesNotThrow(() => process.kill(Number(bystander), 0), "unrelated process untouched");
    const log = events(launch);
    assert.equal(log.find((event) => event.event === "stop")?.reason, "project-cap-exceeded", "the real core's refused-growth reason");
    assert.deepEqual(log.filter((event) => event.event === "exit").map((event) => [event.stoppedForBudget, event.release, event.released]), [[true, "failed", true]]);
    assert.equal(r.status(launch.storage.leaseId).leaseState, "absent", "reservation released as failed, never completed");
  } finally {
    try { process.kill(Number(bystander), "SIGTERM"); } catch { /* gone */ }
    r.done();
  }
});
