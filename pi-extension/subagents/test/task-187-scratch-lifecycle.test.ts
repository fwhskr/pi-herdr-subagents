import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { allocateScratch, cancelUnstartedScratch, capacityWarning, cleanupClosedScratch, closeScratch, processIdentity, startScratch } from "../scratch-lifecycle.ts";

const fixtures = "/home/kris/.pi/agent/var/task-187-fixtures";

test("successful and failed fake workers inherit unique owned scratch, retaining session outputs", async () => {
  const { prepareLaunchScript } = await import("../terminal.ts");
  mkdirSync(fixtures, { recursive: true });
  const root = mkdtempSync(join(fixtures, "launch-"));
  try {
    const sessionFile = join(root, "session.jsonl");
    writeFileSync(sessionFile, "session output\n");
    const child = join(root, "child.cjs");
    writeFileSync(child, `const fs = require('node:fs'); fs.writeFileSync(process.env.TMPDIR + '/ephemeral', 'scratch'); fs.writeFileSync(process.argv[2], process.env.TMPDIR); process.exit(Number(process.argv[3]));`);
    const paths: string[] = [];
    for (const exit of [0, 7]) {
      const capture = join(root, `capture-${exit}`);
      const launch = prepareLaunchScript(`exec '${process.execPath}' '${child}' '${capture}' ${exit}`, {
        scriptPath: join(root, `retained-${exit}.sh`),
        scriptPreamble: `# Session: ${sessionFile}\nprintf preamble > "$TMPDIR/preamble"`,
        stderrFile: join(root, `stderr-${exit}.log`),
        scratchBase: join(root, "leases"),
      });
      paths.push(launch.scratch.scratchRoot);
      try { execFileSync("bash", [launch.scriptPath], { timeout: 5000 }); } catch (error) { assert.equal((error as { status: number }).status, exit); }
      assert.equal(readFileSync(capture, "utf8"), launch.scratch.scratchRoot);
      assert.equal(existsSync(launch.scratch.scratchRoot), false);
      const lease = JSON.parse(readFileSync(launch.scratch.leasePath, "utf8"));
      assert.equal(lease.sessionFile, sessionFile);
      assert.ok(lease.closedAt);
      assert.equal(lease.version, 1);
      assert.equal(lease.launchId, launch.scratch.launchId);
      assert.ok(Number.isSafeInteger(lease.pid));
      assert.match(lease.startTime, /^\d+$/);
      assert.equal(existsSync(launch.scriptPath), true);
      const retainedScript = readFileSync(launch.scriptPath, "utf8");
      const outerLines = retainedScript.split("\n");
      assert.deepEqual(outerLines.slice(0, 3), [
        "#!/bin/bash",
        "export GIT_SSH_COMMAND='/usr/bin/ssh -o BatchMode=yes -o NumberOfPasswordPrompts=0'",
        "export SSH_ASKPASS=/bin/false SSH_ASKPASS_REQUIRE=never DISPLAY=",
      ]);
      assert.equal(outerLines[3], `export TMPDIR='${launch.scratch.scratchRoot}'`);
      assert.ok(outerLines[4].startsWith("trap "));
      assert.ok(outerLines[5].includes("--scratch-lifecycle start "));
      const workerHeader = [
        "#!/bin/bash",
        "export GIT_SSH_COMMAND='/usr/bin/ssh -o BatchMode=yes -o NumberOfPasswordPrompts=0'",
        "export SSH_ASKPASS=/bin/false SSH_ASKPASS_REQUIRE=never DISPLAY=",
      ].join("\n");
      const workerStart = retainedScript.indexOf("cat > ");
      assert.notEqual(workerStart, -1);
      assert.ok(retainedScript.slice(workerStart).includes(`\n${workerHeader}\n`));
      assert.ok(retainedScript.includes(`# Session: ${sessionFile}`));
      assert.ok(retainedScript.includes(`exec '${process.execPath}' '${child}' '${capture}' ${exit}`));
      assert.equal(existsSync(join(root, `stderr-${exit}.log`)), true);
    }
    assert.notEqual(paths[0], paths[1]);
    assert.equal(readFileSync(sessionFile, "utf8"), "session output\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("lifecycle helpers receive sanitized transport settings despite unsafe inherited values", async () => {
  const { prepareLaunchScript } = await import("../terminal.ts");
  withScratch((base) => {
    mkdirSync(base, { recursive: true });
    const capture = join(base, "helper-environment");
    const fakeHelper = join(base, "fake-node");
    writeFileSync(fakeHelper, [
      "#!/bin/bash",
      `printf '%s|%s|%s|%s\\n' "$GIT_SSH_COMMAND" "$SSH_ASKPASS" "$SSH_ASKPASS_REQUIRE" "$DISPLAY" >> "$CAPTURE_ENV"`,
      "",
    ].join("\n"), { mode: 0o700 });
    const originalExecPath = process.execPath;
    let launch: ReturnType<typeof prepareLaunchScript>;
    try {
      Object.defineProperty(process, "execPath", { value: fakeHelper });
      launch = prepareLaunchScript("true", { scratchBase: base });
    } finally {
      Object.defineProperty(process, "execPath", { value: originalExecPath });
    }
    let cancelled = false;
    try {
      execFileSync("bash", [launch.scriptPath], {
        timeout: 5000,
        env: {
          ...process.env,
          CAPTURE_ENV: capture,
          GIT_SSH_COMMAND: "prompt-capable ssh",
          SSH_ASKPASS: "prompt-capable-helper",
          SSH_ASKPASS_REQUIRE: "force",
          DISPLAY: ":1",
        },
      });
      const safeEnvironment = "/usr/bin/ssh -o BatchMode=yes -o NumberOfPasswordPrompts=0|/bin/false|never|";
      assert.deepEqual(readFileSync(capture, "utf8").trimEnd().split("\n"), [safeEnvironment, safeEnvironment]);
    } finally {
      cancelled = cancelUnstartedScratch(launch.scratch);
    }
    assert.equal(cancelled, true);
  });
});

function withScratch(run: (base: string) => void): void {
  mkdirSync(fixtures, { recursive: true });
  const root = mkdtempSync(join(fixtures, "custody-"));
  try { run(join(root, "leases")); }
  finally { rmSync(root, { recursive: true, force: true }); }
}
const healthy = () => ({ availableBytes: 1024 ** 3, availableInodes: 10000 });

test("closed owned scratch only: retain another live launch, session, unknown identity and fields", () => {
  withScratch((base) => {
    const sessionFile = join(base, "session.jsonl");
    const first = allocateScratch(sessionFile, { scratchBase: base, capacity: healthy });
    const other = allocateScratch(null, { scratchBase: base, capacity: healthy });
    writeFileSync(sessionFile, "retained");
    writeFileSync(join(other.scratchRoot, "live"), "live scratch");
    assert.equal(startScratch(first.leasePath, 123, () => "456"), true);
    assert.equal(startScratch(other.leasePath, 124, () => "457"), true);
    const lease = JSON.parse(readFileSync(first.leasePath, "utf8"));
    lease.futureField = { allowed: true };
    writeFileSync(first.leasePath, JSON.stringify(lease));
    assert.equal(closeScratch(first.leasePath, 123, { identity: () => undefined, childrenClosed: () => true }), false);
    assert.equal(closeScratch(first.leasePath, 123, { identity: () => "999", childrenClosed: () => true }), false);
    assert.equal(closeScratch(first.leasePath, 123, { identity: () => "456", childrenClosed: () => false }), false);
    assert.equal(cleanupClosedScratch(first.leasePath, () => null), false);
    assert.equal(existsSync(first.scratchRoot), true);
    assert.equal(closeScratch(first.leasePath, 123, { identity: () => "456", childrenClosed: () => true }), true);
    assert.equal(existsSync(first.scratchRoot), false);
    assert.deepEqual(JSON.parse(readFileSync(first.leasePath, "utf8")).futureField, { allowed: true });
    assert.equal(cleanupClosedScratch(other.leasePath, () => null), false);
    assert.equal(readFileSync(join(other.scratchRoot, "live"), "utf8"), "live scratch");
    assert.equal(readFileSync(sessionFile, "utf8"), "retained");
  });
});

test("independent cleanup retains live, reused and unknown PIDs; only a closed absent owner is removed", () => {
  withScratch((base) => {
    const scratch = allocateScratch(null, { scratchBase: base, capacity: healthy });
    assert.equal(startScratch(scratch.leasePath, 123, () => "456"), true);
    const lease = JSON.parse(readFileSync(scratch.leasePath, "utf8"));
    writeFileSync(scratch.leasePath, JSON.stringify({ ...lease, closedAt: new Date().toISOString() }));
    for (const identity of ["456", "789", undefined]) {
      assert.equal(cleanupClosedScratch(scratch.leasePath, () => identity), false);
      assert.equal(existsSync(scratch.scratchRoot), true);
    }
    assert.equal(cleanupClosedScratch(scratch.leasePath, () => null), true);
    assert.equal(existsSync(scratch.scratchRoot), false);
    assert.equal(existsSync(scratch.leasePath), true);
  });
});

test("pending dispatch failure cancels only its unchanged owned allocation", () => {
  withScratch((base) => {
    const pending = allocateScratch(null, { scratchBase: base, capacity: healthy });
    const started = allocateScratch(null, { scratchBase: base, capacity: healthy });
    assert.equal(startScratch(started.leasePath, 123, () => "456"), true);
    assert.equal(cancelUnstartedScratch(started), false);
    assert.equal(cancelUnstartedScratch({ ...pending, launchId: started.launchId }), false);
    assert.equal(cancelUnstartedScratch(pending), true);
    assert.equal(existsSync(pending.scratchRoot), false);
    assert.equal(existsSync(started.scratchRoot), true);
    assert.ok(JSON.parse(readFileSync(pending.leasePath, "utf8")).closedAt);
  });
});

test("unknown lease identity and symlink/path tampering never remove any scratch", () => {
  withScratch((base) => {
    const scratch = allocateScratch(null, { scratchBase: base, capacity: healthy });
    const victim = allocateScratch(null, { scratchBase: base, capacity: healthy });
    const original = JSON.parse(readFileSync(scratch.leasePath, "utf8"));
    for (const patch of [{ version: 2 }, { pid: null }, { startTime: null }, { scratchRoot: victim.scratchRoot }, { launchId: "unknown" }]) {
      writeFileSync(scratch.leasePath, JSON.stringify({ ...original, pid: 123, startTime: "456", closedAt: new Date().toISOString(), ...patch }));
      assert.equal(cleanupClosedScratch(scratch.leasePath, () => null), false);
      assert.equal(existsSync(scratch.scratchRoot), true);
      assert.equal(existsSync(victim.scratchRoot), true);
    }
    rmSync(scratch.scratchRoot, { recursive: true });
    symlinkSync(victim.scratchRoot, scratch.scratchRoot);
    writeFileSync(scratch.leasePath, JSON.stringify({ ...original, pid: 123, startTime: "456", closedAt: new Date().toISOString() }));
    assert.equal(cleanupClosedScratch(scratch.leasePath, () => null), false);
    assert.equal(existsSync(victim.scratchRoot), true);
  });
});

test("low inode/space and failed capacity diagnostics advise without refusing allocation", () => {
  withScratch((base) => {
    for (const capacity of [() => ({ availableBytes: 0, availableInodes: 10000 }), () => ({ availableBytes: 1024 ** 3, availableInodes: 0 }), () => { throw new Error("unavailable"); }]) {
      const warnings: string[] = [];
      const scratch = allocateScratch(null, { scratchBase: base, capacity, warn: (warning) => warnings.push(warning) });
      assert.equal(warnings.length, 1);
      assert.ok(warnings[0].length <= 240);
      assert.equal(existsSync(scratch.scratchRoot), true);
      assert.equal(cancelUnstartedScratch(scratch), true);
    }
    const scratch = allocateScratch(null, { scratchBase: base, capacity: () => ({ availableBytes: 0, availableInodes: 0 }), warn: () => { throw new Error("sink unavailable"); } });
    assert.equal(existsSync(scratch.scratchRoot), true);
    assert.equal(capacityWarning(base, healthy), null);
    assert.equal(cancelUnstartedScratch(scratch), true);
  });
});

test("Linux process start identity is exact and absent PID is distinguishable", () => {
  assert.match(processIdentity(process.pid)!, /^\d+$/);
  assert.equal(processIdentity(2147483647), null);
});

test("preamble failure cleans default ephemeral scripts without running worker", async () => {
  const { prepareLaunchScript } = await import("../terminal.ts");
  withScratch((base) => {
    const output = join(base, "must-not-run");
    const launch = prepareLaunchScript(`touch '${output}'`, { scratchBase: base, scriptPreamble: "exit 9" });
    assert.throws(() => execFileSync("bash", [launch.scriptPath], { timeout: 5000 }), (error: unknown) => (error as { status: number }).status === 9);
    assert.equal(existsSync(output), false);
    assert.equal(existsSync(launch.scriptPath), false);
    assert.equal(existsSync(launch.scratch.scratchRoot), false);
    assert.ok(JSON.parse(readFileSync(launch.scratch.leasePath, "utf8")).closedAt);
  });
});

test("script preparation failure closes only the just-allocated scratch", async () => {
  const { prepareLaunchScript } = await import("../terminal.ts");
  withScratch((base) => {
    const other = allocateScratch(null, { scratchBase: base, capacity: healthy });
    assert.equal(startScratch(other.leasePath, 123, () => "456"), true);
    const obstruction = join(base, "file-not-directory");
    writeFileSync(obstruction, "retained");
    assert.throws(() => prepareLaunchScript("true", { scratchBase: base, scriptPath: join(obstruction, "launch.sh") }));
    const created = readdirSync(base).filter((name) => name !== other.launchId && name !== "file-not-directory");
    assert.equal(created.length, 1);
    const lease = JSON.parse(readFileSync(join(base, created[0], "lease.json"), "utf8"));
    assert.ok(lease.closedAt);
    assert.equal(existsSync(lease.scratchRoot), false);
    assert.equal(existsSync(other.scratchRoot), true);
    assert.equal(readFileSync(obstruction, "utf8"), "retained");
  });
});
