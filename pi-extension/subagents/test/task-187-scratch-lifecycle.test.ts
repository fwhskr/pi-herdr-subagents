import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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
      const launch = prepareLaunchScript(`'${process.execPath}' '${child}' '${capture}' ${exit}`, { sessionFile, scratchBase: join(root, "leases") });
      paths.push(launch.scratch.scratchRoot);
      try { execFileSync("bash", [launch.scriptPath], { timeout: 5000 }); } catch (error) { assert.equal((error as { status: number }).status, exit); }
      assert.equal(readFileSync(capture, "utf8"), launch.scratch.scratchRoot);
      assert.equal(existsSync(launch.scratch.scratchRoot), false);
      const lease = JSON.parse(readFileSync(launch.scratch.leasePath, "utf8"));
      assert.equal(lease.sessionFile, sessionFile);
      assert.ok(lease.closedAt);
    }
    assert.notEqual(paths[0], paths[1]);
    assert.equal(readFileSync(sessionFile, "utf8"), "session output\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
