// Synthetic storage-budget CLI double for launch tests that are not about admission:
// admits every reserve and accepts every other operation. Never touches a real ledger.
import { readFileSync } from "node:fs";
const op = process.argv[2];
const req = JSON.parse(readFileSync(0, "utf8") || "{}");
process.stdout.write(JSON.stringify(op === "reserve"
  ? { admitted: true, leaseId: `double-${req.launchId}`, freeBytes: 0, reservedBytes: 0, estimatedBytes: req.estimatedBytes, remainingBytes: 0, floorBytes: 0 }
  : { ok: true }) + "\n");
