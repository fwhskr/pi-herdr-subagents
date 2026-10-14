import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SCRATCH_BASE = "/home/kris/.pi/agent/var/lane-scratch";
const PI_ROOT = "/home/kris/.pi";

export interface ScratchLease {
  version: 1;
  launchId: string;
  sessionFile: string | null;
  scratchRoot: string;
  pid: number | null;
  /** Linux /proc stat start-time ticks, not a wall-clock timestamp. */
  startTime: string | null;
  createdAt: string;
  closedAt: string | null;
  [key: string]: unknown;
}
export interface LaunchScratch { launchId: string; leasePath: string; scratchRoot: string }
export interface Capacity { availableBytes: number; availableInodes: number }
export type ProcessIdentity = (pid: number) => string | null | undefined;

/** null = absent, undefined = identity cannot be proved. Never guess at PID reuse. */
export const processIdentity: ProcessIdentity = (pid) => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    return /^\d+$/.test(fields[19] ?? "") ? fields[19] : undefined;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : undefined;
  }
};

function readCapacity(path: string): Capacity {
  const stat = statfsSync(path);
  return { availableBytes: stat.bavail * stat.bsize, availableInodes: stat.ffree };
}

/** Advisory only: an unavailable or low capacity observation never refuses a launch. */
export function capacityWarning(path: string, inspect = readCapacity): string | null {
  try {
    const capacity = inspect(path);
    if (capacity.availableBytes < 16 * 1024 * 1024 || capacity.availableInodes < 1024) {
      return `[subagent scratch] low capacity: ${capacity.availableBytes} bytes, ${capacity.availableInodes} inodes available`.slice(0, 240);
    }
  } catch { return "[subagent scratch] capacity observation unavailable; launch continues"; }
  return null;
}

function writeLease(path: string, lease: ScratchLease): void {
  const temporary = `${path}.${randomUUID()}.new`;
  writeFileSync(temporary, `${JSON.stringify(lease)}\n`, { mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
}

export function allocateScratch(sessionFile: string | null, options: {
  scratchBase?: string; capacity?: (path: string) => Capacity; warn?: (warning: string) => void;
} = {}): LaunchScratch {
  const base = resolve(options.scratchBase ?? SCRATCH_BASE);
  if (!base.startsWith(`${PI_ROOT}/`)) throw new Error("Launch scratch must stay inside /home/kris/.pi");
  mkdirSync(base, { recursive: true, mode: 0o700 });
  if (realpathSync(base) !== base) throw new Error("Launch scratch base must not traverse symlinks");
  const warning = capacityWarning(base, options.capacity);
  if (warning) {
    // Diagnostics must not turn advisory capacity into a launch refusal.
    try { (options.warn ?? console.warn)(warning); } catch { /* advisory sink */ }
  }
  const launchId = randomUUID();
  const launchRoot = join(base, launchId);
  mkdirSync(launchRoot, { mode: 0o700 });
  const scratchRoot = join(launchRoot, "scratch");
  const leasePath = join(launchRoot, "lease.json");
  // Persist custody before creating ephemeral data; metadata-write failure leaves no scratch.
  writeLease(leasePath, { version: 1, launchId, sessionFile, scratchRoot, pid: null, startTime: null,
    createdAt: new Date().toISOString(), closedAt: null });
  mkdirSync(scratchRoot, { mode: 0o700 });
  return { launchId, leasePath, scratchRoot };
}

/** Exact owned child only; never delete the lease, siblings, or session artifacts. */
function ownedLease(leasePath: string): ScratchLease | null {
  try {
    const path = resolve(leasePath);
    const root = dirname(path);
    if (!path.startsWith(`${PI_ROOT}/`) || path !== join(root, "lease.json") || realpathSync(root) !== root) return null;
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.uid !== process.getuid?.()) return null;
    const lease = JSON.parse(readFileSync(path, "utf8")) as ScratchLease;
    if (lease.version !== 1 || !/^[a-f0-9-]{36}$/.test(lease.launchId) || root !== join(dirname(root), lease.launchId)
      || lease.scratchRoot !== join(root, "scratch") || typeof lease.createdAt !== "string"
      || !(lease.sessionFile === null || typeof lease.sessionFile === "string")) return null;
    const scratch = lstatSync(lease.scratchRoot);
    if (!scratch.isDirectory() || scratch.uid !== metadata.uid || realpathSync(lease.scratchRoot) !== lease.scratchRoot) return null;
    return lease;
  } catch { return null; }
}

export function startScratch(leasePath: string, pid: number, inspect: ProcessIdentity = processIdentity): boolean {
  const lease = ownedLease(leasePath);
  const startTime = inspect(pid);
  if (!lease || lease.closedAt !== null || lease.pid !== null || lease.startTime !== null
    || !Number.isSafeInteger(pid) || pid <= 0 || !startTime) return false;
  writeLease(leasePath, { ...lease, pid, startTime });
  return true;
}

/** For independent sweep: only closed leases whose owner is provably absent. */
export function cleanupClosedScratch(leasePath: string, inspect: ProcessIdentity = processIdentity): boolean {
  const lease = ownedLease(leasePath);
  if (!lease || typeof lease.closedAt !== "string" || !Number.isSafeInteger(lease.pid) || (lease.pid ?? 0) <= 0
    || typeof lease.startTime !== "string" || !/^\d+$/.test(lease.startTime)) return false;
  if (inspect(lease.pid!) !== null) return false;
  rmSync(lease.scratchRoot, { recursive: true, force: true });
  return true;
}

function noOtherChildren(pid: number): boolean {
  try {
    const children = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean);
    return children.every((child) => Number(child) === process.pid);
  } catch { return false; }
}

/** Called by the supervising shell's EXIT trap, after its foreground worker ends. */
export function closeScratch(leasePath: string, pid: number, options: {
  identity?: ProcessIdentity; childrenClosed?: (pid: number) => boolean;
} = {}): boolean {
  const lease = ownedLease(leasePath);
  if (!lease || lease.closedAt !== null || lease.pid !== pid || !lease.startTime
    || (options.identity ?? processIdentity)(pid) !== lease.startTime) return false;
  // Even an exited foreground worker may leave background children. Retain in that case.
  if (!(options.childrenClosed ?? noOtherChildren)(pid)) return false;
  writeLease(leasePath, { ...lease, closedAt: new Date().toISOString() });
  rmSync(lease.scratchRoot, { recursive: true, force: true });
  return true;
}

/** Dispatch failed before any worker owned this allocation. No unknown/live lease is cancelled. */
export function cancelUnstartedScratch(scratch: LaunchScratch): boolean {
  const lease = ownedLease(scratch.leasePath);
  if (!lease || lease.launchId !== scratch.launchId || lease.scratchRoot !== scratch.scratchRoot
    || lease.pid !== null || lease.startTime !== null || lease.closedAt !== null) return false;
  writeLease(scratch.leasePath, { ...lease, closedAt: new Date().toISOString() });
  rmSync(lease.scratchRoot, { recursive: true, force: true });
  return true;
}

// The helper runs in a fresh local Node child, never imports the extension entrypoint.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === "--scratch-lifecycle") {
  const [, , , action, leasePath, pid] = process.argv;
  try {
    const ok = action === "start" ? startScratch(leasePath, Number(pid)) : action === "close" ? closeScratch(leasePath, Number(pid)) : false;
    if (!ok) console.warn("[subagent scratch] custody unknown; ephemeral scratch retained");
  } catch { console.warn("[subagent scratch] lifecycle unavailable; ephemeral scratch retained"); }
}
