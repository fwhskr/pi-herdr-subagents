import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { processIdentity } from "../scratch-lifecycle.ts";
import { prepareLaunchScript, runScriptInPane } from "../terminal.ts";
import {
  canonicalProject, releaseLaunchStorage, reserveLaunchStorage, settleLaunchStorage, StorageRefusal,
  type StorageAdmissionOptions, type StorageLease,
} from "../storage-admission.ts";

// TASK-283: terminal launch preparation reserves shared disk headroom through the
// standalone storage-budget CLI (JSON on stdin, one JSON response). The CLI here is a
// tiny synthetic double; nothing allocates real space or touches the real ledger.
const fixtures = "/home/kris/.pi/agent/var/task-283-fixtures";
const GiB = 1024 ** 3;

interface Call { op: string; req: Record<string, any>; baseExists: boolean }

function fixture(): { root: string; base: string; cli: string; mode: (value: string) => void; calls: () => Call[]; done: () => void } {
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
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ op, req, baseExists: existsSync(${JSON.stringify(base)}) }) + "\\n");
const mode = readFileSync(${JSON.stringify(modeFile)}, "utf8").trim();
const out = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
if (mode === "hang") setTimeout(() => {}, 60000);
else if (mode === "garbage") process.stdout.write("not json");
else if (mode === "exit1") process.exit(1);
else if (op === "reserve" && mode === "deny") out({ admitted: false, reason: "insufficient-headroom", freeBytes: 1000, reservedBytes: 500, estimatedBytes: req.estimatedBytes, remainingBytes: -1, floorBytes: 99 });
else if (op === "reserve" && mode === "nolease") out({ admitted: true });
else if (op !== "reserve" && mode === "failrelease") process.exit(1);
else if (op === "renew" && mode === "denygrow" && ("consumedBytes" in req || "estimatedBytes" in req)) out({ ok: true, admitted: false, reason: "insufficient-space", action: "stop-owned-producer", leaseId: req.leaseId, freeBytes: 1, reservedBytes: 0, estimatedBytes: ${2 * GiB}, remainingBytes: -1, floorBytes: 1 });
else if (op === "reserve") out({ admitted: true, leaseId: "lease-" + req.launchId, freeBytes: 100 * ${GiB}, reservedBytes: 0, estimatedBytes: req.estimatedBytes, remainingBytes: 98 * ${GiB}, floorBytes: 64 * ${GiB} });
else out({ ok: true });
`);
  return {
    root, base, cli,
    mode: (value) => writeFileSync(modeFile, value),
    calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []),
    done: () => rmSync(root, { recursive: true, force: true }),
  };
}

const bootId = () => readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();

test("low space, unreadable or malformed ledger refuse before any scratch, script or transport", () => {
  const f = fixture();
  try {
    f.mode("deny");
    const scriptPath = join(f.root, "launch.sh");
    assert.throws(() => prepareLaunchScript("true", { scratchBase: f.base, scriptPath, storage: { cli: f.cli } }), (error: unknown) => {
      assert.ok(error instanceof StorageRefusal);
      assert.match(error.message, /free 1000/);
      assert.match(error.message, /reserved 500/);
      assert.match(error.message, /floor 99/);
      assert.match(error.message, new RegExp(`request ${2 * GiB}`));
      assert.ok(error.message.length <= 600);
      return true;
    });
    // runScriptInPane reaches the same gate before the pane transport (herdr is absent here).
    assert.throws(() => runScriptInPane("pane-x", "true", { scratchBase: f.base, scriptPath, storage: { cli: f.cli } }), StorageRefusal);
    for (const mode of ["garbage", "exit1", "nolease", "hang"]) {
      f.mode(mode);
      assert.throws(() => prepareLaunchScript("true", { scratchBase: f.base, scriptPath, storage: { cli: f.cli, timeoutMs: 500 } }), StorageRefusal, mode);
    }
    assert.throws(() => prepareLaunchScript("true", { scratchBase: f.base, scriptPath, storage: { cli: join(f.root, "missing.mjs") } }), StorageRefusal);
    assert.throws(() => prepareLaunchScript("true", { scratchBase: f.base, scriptPath, storage: { cli: f.cli, readBootId: () => null } }), /boot/i);
    assert.throws(() => prepareLaunchScript("true", { scratchBase: f.base, scriptPath, storage: { cli: f.cli, identity: () => undefined } }), StorageRefusal);
    assert.equal(existsSync(f.base), false, "no scratch base or lease may be created");
    assert.equal(existsSync(scriptPath), false);
    assert.ok(f.calls().every((call) => call.op === "reserve"));
  } finally { f.done(); }
});

test("permitted launch reserves before scratch, binds the real supervisor and settles on exit", () => {
  const f = fixture();
  try {
    const sessionFile = join(f.root, "session.jsonl");
    writeFileSync(sessionFile, "session output\n");
    const capture = join(f.root, "tmpdir");
    const launch = prepareLaunchScript(`printf %s "$TMPDIR" > '${capture}'; exit 3`, {
      scratchBase: f.base, scriptPath: join(f.root, "launch.sh"), scriptPreamble: `# Session: ${sessionFile}`,
      storage: { cli: f.cli, project: "/home/kris/.pi" },
    });
    const [reserve, ...rest] = f.calls();
    assert.equal(reserve.op, "reserve");
    assert.equal(reserve.baseExists, false, "lease acquired before scratch allocation");
    assert.deepEqual(rest, []);
    assert.equal(reserve.req.destination, f.root, "nearest existing ancestor of the scratch base");
    assert.equal(reserve.req.project, "/home/kris/.pi");
    assert.equal(reserve.req.class, "source");
    assert.equal(reserve.req.estimatedBytes, 2 * GiB);
    assert.match(reserve.req.launchId, /^[a-f0-9-]{36}$/);
    assert.deepEqual(reserve.req.producer, { pid: process.pid, startTime: processIdentity(process.pid), bootId: bootId() });

    try { execFileSync("bash", [launch.scriptPath], { timeout: 10000 }); assert.fail("exit status expected"); }
    catch (error) { assert.equal((error as { status: number }).status, 3); }
    assert.equal(readFileSync(capture, "utf8"), launch.scratch.scratchRoot, "TMPDIR contract preserved");
    assert.equal(readFileSync(sessionFile, "utf8"), "session output\n");

    const lease = JSON.parse(readFileSync(launch.scratch.leasePath, "utf8"));
    const [, bind, release] = f.calls();
    assert.equal(bind.op, "renew");
    assert.deepEqual(bind.req.producer, { pid: lease.pid, startTime: lease.startTime, bootId: bootId() });
    assert.equal(bind.req.leaseId, reserve.req.launchId ? `lease-${reserve.req.launchId}` : "");
    assert.equal(release.op, "release");
    assert.equal(release.req.leaseId, bind.req.leaseId);
    assert.deepEqual(release.req.producer, bind.req.producer);
    assert.equal(release.req.reason, "completed");
    assert.equal(release.req.exitStatus, 3);
    assert.equal(launch.storage.leaseId, bind.req.leaseId);
  } finally { f.done(); }
});

test("a refused bind never starts the worker; the reservation is not released without proof", () => {
  const f = fixture();
  try {
    const marker = join(f.root, "ran");
    const launch = prepareLaunchScript(`touch '${marker}'`, { scratchBase: f.base, scriptPath: join(f.root, "launch.sh"), storage: { cli: f.cli } });
    f.mode("failrelease");
    try { execFileSync("bash", [launch.scriptPath], { timeout: 10000, stdio: "ignore" }); assert.fail("refusal expected"); }
    catch (error) { assert.equal((error as { status: number }).status, 75); }
    assert.equal(existsSync(marker), false);
    assert.equal(f.calls().filter((call) => call.op === "release" && call.req.reason === "completed").length, 0);
  } finally { f.done(); }
});

test("preparation failure and transport failure settle only the unstarted reservation", () => {
  const f = fixture();
  try {
    const obstruction = join(f.root, "obstruction");
    writeFileSync(obstruction, "file");
    assert.throws(() => prepareLaunchScript("true", { scratchBase: f.base, scriptPath: join(obstruction, "launch.sh"), storage: { cli: f.cli } }));
    let calls = f.calls();
    assert.deepEqual(calls.map((call) => call.op), ["reserve", "release"]);
    assert.equal(calls[1].req.reason, "cancelled");
    assert.equal(calls[1].req.leaseId, `lease-${calls[0].req.launchId}`);
    assert.deepEqual(calls[1].req.producer, calls[0].req.producer);
    assert.deepEqual(readdirSync(join(f.base)).map((id) => existsSync(join(f.base, id, "scratch"))), [false]);

    // Dispatch to a pane that cannot exist (no herdr here) cancels the unstarted launch and its lease.
    const scriptPath = join(f.root, "pane.sh");
    assert.throws(() => runScriptInPane("pane-x", "true", { scratchBase: f.base, scriptPath, storage: { cli: f.cli } }), /herdr/i);
    calls = f.calls().slice(2);
    assert.deepEqual(calls.map((call) => call.op), ["reserve", "release"]);
    assert.equal(calls[1].req.reason, "cancelled");
  } finally { f.done(); }
});

test("a failed release keeps the original error and never throws", () => {
  const f = fixture();
  try {
    f.mode("admit");
    const lease = reserveLaunchStorage(f.base, { cli: f.cli, project: "/home/kris/.pi" });
    f.mode("failrelease");
    assert.equal(releaseLaunchStorage(lease, "cancelled"), false);
    f.mode("garbage");
    assert.equal(releaseLaunchStorage(lease, "cancelled"), false);
    f.mode("admit");
    assert.equal(releaseLaunchStorage(lease, "cancelled"), true);
  } finally { f.done(); }
});

test("settle preserves the reservation for live, recycled, unreadable or unfinished producers", () => {
  const f = fixture();
  try {
    const lease: StorageLease = reserveLaunchStorage(f.base, { cli: f.cli, project: "/home/kris/.pi" });
    const before = f.calls().length;
    const pid = 4242;
    const options = (identity: string | null | undefined, closed: boolean) => ({ identity: () => identity, childrenClosed: () => closed });
    // The producer is only proven finished when it is this very process and descendants are closed.
    assert.equal(settleLaunchStorage(lease, pid, 0, { ...options(undefined, true), readBootId: bootId }), false);
    assert.equal(settleLaunchStorage(lease, pid, 0, { ...options("111", true), readBootId: bootId, expectedStartTime: "222" }), false);
    assert.equal(settleLaunchStorage(lease, pid, 0, { ...options("222", false), readBootId: bootId, expectedStartTime: "222" }), false);
    assert.equal(settleLaunchStorage(lease, pid, 0, { ...options("222", true), readBootId: () => null, expectedStartTime: "222" }), false);
    assert.equal(f.calls().length, before, "nothing released");
    assert.equal(settleLaunchStorage(lease, pid, 0, { ...options("222", true), readBootId: bootId, expectedStartTime: "222" }), true);
    assert.equal(f.calls().at(-1)!.op, "release");
  } finally { f.done(); }
});

test("surviving descendants of a real supervisor keep the reservation", () => {
  const f = fixture();
  const pidFile = join(f.root, "survivor.pid");
  try {
    const launch = prepareLaunchScript(`sleep 5 >/dev/null 2>&1 & echo $! > '${pidFile}'`, {
      scratchBase: f.base, scriptPath: join(f.root, "launch.sh"), storage: { cli: f.cli },
    });
    // setsid makes the supervisor a process-group leader, as an interactive pane shell does.
    execFileSync("setsid", ["-w", "bash", launch.scriptPath], { timeout: 10000, stdio: "ignore" });
    assert.deepEqual(f.calls().map((call) => call.op), ["reserve", "renew"], "no release while a descendant lives");
  } finally {
    try { process.kill(Number(readFileSync(pidFile, "utf8")), "SIGTERM"); } catch { /* already gone */ }
    f.done();
  }
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

// ---- TASK-283 rescue red contract: interactive terminal + shared-ledger growth monitoring ----
// Architecture for binding the pane job is pending; these pin the behavior any choice must keep.
// Monitoring seam requested from the adapter: StorageAdmissionOptions.monitorIntervalMs (test cadence only).
const fast = (cli: string): StorageAdmissionOptions => ({ cli, monitorIntervalMs: 100 } as StorageAdmissionOptions);

function inPty(scriptPath: string, timeout = 15000): number {
  // `script` gives the launch a real pseudo-terminal, as the herdr pane does.
  try { execFileSync("script", ["-qec", `bash ${scriptPath}`, "/dev/null"], { timeout, stdio: ["ignore", "ignore", "ignore"] }); return 0; }
  catch (error) { return (error as { status: number }).status; }
}

test("the worker keeps the pane terminal: tty stdin/stdout, foreground job control and resize SIGWINCH", () => {
  const f = fixture();
  try {
    const out = join(f.root, "tty.out");
    const worker = [
      `trap 'echo winch >> ${out}' WINCH`,
      `[ -t 0 ] && echo stdin-tty >> '${out}'`,
      `[ -t 1 ] && echo stdout-tty >> '${out}'`,
      `read pg tp < <(ps -o pgid=,tpgid= -p $$); [ "$pg" = "$tp" ] && echo foreground >> '${out}'`,
      // TIOCSWINSZ on the controlling tty signals only its foreground process group.
      "stty cols 101 rows 31 </dev/tty; sleep 0.3; true",
    ].join("\n");
    const launch = prepareLaunchScript(worker, { scratchBase: f.base, scriptPath: join(f.root, "launch.sh"), storage: fast(f.cli) });
    assert.equal(inPty(launch.scriptPath), 0);
    assert.deepEqual(readFileSync(out, "utf8").trim().split("\n"), ["stdin-tty", "stdout-tty", "foreground", "winch"]);
  } finally { f.done(); }
});

test("owned output growth is reported to the shared ledger while the worker runs", () => {
  const f = fixture();
  try {
    const launch = prepareLaunchScript(`head -c 4194304 /dev/zero > "$TMPDIR/grown"; sync; sleep 1.5`, {
      scratchBase: f.base, scriptPath: join(f.root, "launch.sh"), storage: fast(f.cli),
    });
    assert.equal(inPty(launch.scriptPath), 0);
    const leaseId = launch.storage.leaseId;
    const growth = f.calls().filter((call) => call.op === "renew" && call.req.leaseId === leaseId
      && call.req.consumedBytes !== undefined && BigInt(call.req.consumedBytes) >= 4194304n);
    assert.ok(growth.length >= 1, `expected a consumedBytes renewal, saw ${JSON.stringify(f.calls().map((c) => [c.op, c.req.consumedBytes]))}`);
    assert.ok(f.calls().some((call) => call.op === "release" && call.req.leaseId === leaseId), "settled after exit");
  } finally { f.done(); }
});

test("refused growth stops only the owned worker tree and keeps the reservation", () => {
  const f = fixture();
  const finished = join(f.root, "finished");
  const bystander = execFileSync("bash", ["-c", "setsid sleep 30 >/dev/null 2>&1 & echo $!"], { encoding: "utf8" }).trim();
  try {
    const launch = prepareLaunchScript(`head -c 4194304 /dev/zero > "$TMPDIR/grown"; sync; sleep 6; touch '${finished}'`, {
      scratchBase: f.base, scriptPath: join(f.root, "launch.sh"), storage: fast(f.cli),
    });
    f.mode("denygrow");
    const started = Date.now();
    const status = inPty(launch.scriptPath);
    assert.ok(Date.now() - started < 5000, "stopped promptly, not after the worker finished");
    assert.equal(status, 75, "budget stop exit status");
    assert.equal(existsSync(finished), false, "worker production stopped");
    assert.doesNotThrow(() => process.kill(Number(bystander), 0), "unrelated process untouched");
    assert.equal(f.calls().filter((call) => call.op === "release" && call.req.reason === "completed").length, 0);
  } finally {
    try { process.kill(Number(bystander), "SIGTERM"); } catch { /* gone */ }
    f.done();
  }
});
