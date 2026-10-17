// Synthetic storage-budget CLI double for launch tests that are not about admission:
// admits every reserve, settles every release, and for `run` simply starts the child after `--`
// in the foreground. Never touches a real ledger; admission behavior is tested in storage-admission.test.ts.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
const op = process.argv[2];
if (op === "run") {
  const dd = process.argv.indexOf("--");
  const [cmd, ...args] = process.argv.slice(dd + 1);
  const r = spawnSync(cmd, args, { stdio: ["inherit", "inherit", "inherit", "ignore"] });
  process.exit(r.status ?? 1);
}
const req = JSON.parse(readFileSync(0, "utf8") || "{}");
process.stdout.write(JSON.stringify(op === "reserve"
  ? { ok: true, admitted: true, reason: "admitted", production: true, handoff: "pending", leaseId: `double-${req.launchId}`, freeBytes: 0, reservedBytes: 0, estimatedBytes: 1, remainingBytes: 0, floorBytes: 0 }
  : { ok: true, admitted: true, released: true, reason: req.reason, production: true }) + "\n");
