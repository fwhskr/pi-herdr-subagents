import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { processIdentity, type ProcessIdentity } from "./scratch-lifecycle.ts";

/**
 * TASK-283: shared-filesystem storage admission for delegated launch preparation.
 *
 * Standalone consumer of the storage-budget CLI v1 (operation as argv[2], one JSON
 * request on stdin, one JSON response on stdout). Nothing here imports the CLI's
 * internals; the executable is looked up by absolute path and run bounded.
 *
 * Fail closed: any unreadable, malformed, slow or unadmitting ledger answer refuses the
 * launch before scratch, export or fork. A reservation is released only on proof: the
 * launch was never dispatched, or the bound supervisor itself finished with every
 * descendant closed. Unknown liveness preserves the reservation (never TTL, never kill).
 */
export const STORAGE_BUDGET_CLI = "/home/kris/.pi/agent/skills/using-skills/scripts/storage-budget.mjs";
const NODE = process.execPath; // resolved at load, independent of later execPath swaps
const GiB = 1024 ** 3;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_REFUSAL = 480;
const CLASSES = { source: 2 * GiB, build: 16 * GiB, container: 32 * GiB, artifact: 4 * GiB } as const;
export type StorageClass = keyof typeof CLASSES;

export interface Producer { pid: number; startTime: string; bootId: string }

export interface StorageAdmissionOptions {
  /** Absolute storage-budget executable; defaults to the tracked shared script. */
  cli?: string;
  /** Canonical project identity override; otherwise resolved from `cwd`. */
  project?: string;
  cwd?: string;
  class?: StorageClass;
  /** Explicit estimate in bytes; unknown never costs zero (class default applies). */
  estimatedBytes?: number;
  timeoutMs?: number;
  /** Synthetic seams; production uses /proc. */
  readBootId?: () => string | null | undefined;
  identity?: ProcessIdentity;
}

export interface StorageLease {
  cli: string;
  leaseId: string;
  launchId: string;
  destination: string;
  project: string;
  class: StorageClass;
  estimatedBytes: number;
  producer: Producer;
  timeoutMs: number;
}

export class StorageRefusal extends Error {
  readonly response: unknown;
  constructor(message: string, response?: unknown) {
    super(message.slice(0, MAX_REFUSAL));
    this.name = "StorageRefusal";
    this.response = response;
  }
}

function readBootIdDefault(): string | null {
  try { return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || null; } catch { return null; }
}

function producerFor(pid: number, options: Pick<StorageAdmissionOptions, "readBootId" | "identity">): Producer {
  const bootId = (options.readBootId ?? readBootIdDefault)();
  if (!bootId) throw new StorageRefusal("storage admission unavailable: boot identity unreadable; launch not started");
  const startTime = (options.identity ?? processIdentity)(pid);
  if (!startTime) throw new StorageRefusal("storage admission unavailable: producer identity unreadable; launch not started");
  return { pid, startTime, bootId };
}

/** Resolve a directory to one repository identity: linked worktrees map to their common repo. */
export function canonicalProject(cwd: string = process.cwd()): string {
  let start: string;
  try { start = realpathSync(resolve(cwd)); } catch { start = resolve(cwd); }
  for (let dir = start; ; dir = dirname(dir)) {
    try {
      const entry = join(dir, ".git");
      const stat = lstatSync(entry);
      if (stat.isDirectory()) return dir;
      if (stat.isFile()) {
        const gitdir = /^gitdir:\s*(.+)$/m.exec(readFileSync(entry, "utf8"))?.[1]?.trim();
        if (gitdir) {
          const git = resolve(dir, gitdir);
          let common = git;
          try { common = resolve(git, readFileSync(join(git, "commondir"), "utf8").trim()); } catch { /* plain gitdir */ }
          common = realpathSync(common);
          return basename(common) === ".git" ? dirname(common) : common;
        }
        return dir;
      }
    } catch { /* keep climbing */ }
    if (dirname(dir) === dir) return start;
  }
}

function nearestExisting(path: string): string {
  let dir = resolve(path);
  while (!existsSync(dir)) {
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return realpathSync(dir);
}

function call(cli: string, op: string, request: unknown, timeoutMs: number): { response: Record<string, unknown> } | { failure: string } {
  if (!isAbsolute(cli) || !existsSync(cli)) return { failure: "storage-budget executable not found" };
  const result = spawnSync(NODE, [cli, op], {
    input: JSON.stringify(request), encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 64 * 1024,
    stdio: ["pipe", "pipe", "ignore"],
  });
  if (result.error) return { failure: `storage-budget ${op} did not complete (${(result.error as NodeJS.ErrnoException).code ?? "error"})` };
  if (result.status !== 0) return { failure: `storage-budget ${op} exited ${result.status}` };
  try {
    const parsed = JSON.parse(result.stdout);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { response: parsed as Record<string, unknown> };
  } catch { /* fall through */ }
  return { failure: `storage-budget ${op} returned unreadable output` };
}

const num = (value: unknown): string => (typeof value === "number" && Number.isFinite(value) ? String(value) : "unknown");

/** Acquire a lease before any scratch/export/fork. Throws StorageRefusal; allocates nothing. */
export function reserveLaunchStorage(scratchBase: string, options: StorageAdmissionOptions = {}): StorageLease {
  const cls = options.class ?? "source";
  if (!(cls in CLASSES)) throw new StorageRefusal(`storage admission refused: unknown class ${String(cls).slice(0, 40)}`);
  const estimatedBytes = options.estimatedBytes ?? CLASSES[cls];
  if (!Number.isSafeInteger(estimatedBytes) || estimatedBytes <= 0) {
    throw new StorageRefusal("storage admission refused: estimate must be a positive integer byte count");
  }
  const cli = options.cli ?? STORAGE_BUDGET_CLI;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const producer = producerFor(process.pid, options);
  let destination: string;
  let project: string;
  try {
    destination = nearestExisting(scratchBase);
    project = options.project ?? canonicalProject(options.cwd);
  } catch { throw new StorageRefusal("storage admission unavailable: destination or project unresolved; launch not started"); }
  const launchId = randomUUID();
  const answer = call(cli, "reserve", { destination, project, launchId, class: cls, estimatedBytes, producer }, timeoutMs);
  if ("failure" in answer) throw new StorageRefusal(`storage admission unavailable: ${answer.failure}; launch not started`);
  const r = answer.response;
  if (r.admitted !== true) {
    const reason = typeof r.reason === "string" ? r.reason.replace(/[^\x20-\x7e]/g, "?").slice(0, 80) : "refused";
    throw new StorageRefusal(`storage admission refused (${reason}): free ${num(r.freeBytes)} reserved ${num(r.reservedBytes)} request ${num(r.estimatedBytes ?? estimatedBytes)} floor ${num(r.floorBytes)}`, r);
  }
  if (typeof r.leaseId !== "string" || !/^[\x21-\x7e]{1,200}$/.test(r.leaseId)) {
    throw new StorageRefusal("storage admission unavailable: admitted without a usable lease; launch not started", r);
  }
  return { cli, leaseId: r.leaseId, launchId, destination, project, class: cls, estimatedBytes, producer, timeoutMs };
}

function leaseRequest(lease: StorageLease, producer: Producer, extra: Record<string, unknown>): Record<string, unknown> {
  return { leaseId: lease.leaseId, destination: lease.destination, project: lease.project, launchId: lease.launchId, producer, ...extra };
}

function accepted(answer: ReturnType<typeof call>): boolean {
  return "response" in answer && answer.response.ok !== false && answer.response.released !== false && answer.response.admitted !== false
    && !("error" in answer.response);
}

/** Release a never-dispatched launch (or proven-finished producer). Never throws; false = still reserved. */
export function releaseLaunchStorage(lease: StorageLease, reason: "cancelled" | "completed", producer: Producer = lease.producer, exitStatus?: number): boolean {
  try {
    return accepted(call(lease.cli, "release", leaseRequest(lease, producer, { reason, ...(exitStatus === undefined ? {} : { exitStatus }) }), lease.timeoutMs));
  } catch { return false; }
}

/** Re-attach the lease from the launcher to the real supervising shell. Returns its start time, or null. */
export function bindLaunchStorage(lease: StorageLease, pid: number, options: Pick<StorageAdmissionOptions, "readBootId" | "identity"> = {}): string | null {
  try {
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    const producer = producerFor(pid, options);
    return accepted(call(lease.cli, "renew", leaseRequest(lease, producer, { phase: "bind" }), lease.timeoutMs)) ? producer.startTime : null;
  } catch { return null; }
}

/** Every process of the supervisor's group other than itself and this helper is a survivor. */
export function descendantsClosed(pid: number): boolean {
  try {
    const own = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean);
    if (!own.every((child) => Number(child) === process.pid)) return false;
    const fields = (id: string) => { const s = readFileSync(`/proc/${id}/stat`, "utf8"); return s.slice(s.lastIndexOf(")") + 2).trim().split(/\s+/); };
    // Only a process-group leader (an interactive pane's job) proves a group-wide scan.
    if (Number(fields(String(pid))[2]) !== pid) return true;
    for (const id of readdirSync("/proc")) {
      if (!/^\d+$/.test(id) || Number(id) === pid || Number(id) === process.pid) continue;
      try { if (Number(fields(id)[2]) === pid) return false; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false; }
    }
    return true;
  } catch { return false; }
}

/** Supervisor EXIT-trap settlement: release only on proven identity and closed descendants. */
export function settleLaunchStorage(lease: StorageLease, pid: number, exitStatus: number, options: Pick<StorageAdmissionOptions, "readBootId" | "identity"> & {
  childrenClosed?: (pid: number) => boolean; expectedStartTime?: string | null;
}): boolean {
  try {
    if (!options.expectedStartTime || !/^\d+$/.test(options.expectedStartTime)) return false;
    const producer = producerFor(pid, options);
    if (producer.startTime !== options.expectedStartTime) return false;
    if (!(options.childrenClosed ?? descendantsClosed)(pid)) return false;
    return releaseLaunchStorage(lease, "completed", producer, Number.isSafeInteger(exitStatus) ? exitStatus : undefined);
  } catch { return false; }
}

// Local helper entry for the generated launch script; never imports the extension.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === "--storage-admission") {
  const [, , , action, descriptor, pid, status, expected] = process.argv;
  let ok = false;
  try {
    const lease = JSON.parse(descriptor) as StorageLease;
    if (action === "bind") {
      const startTime = bindLaunchStorage(lease, Number(pid));
      if (startTime) { process.stdout.write(startTime); ok = true; }
    } else if (action === "settle") {
      ok = settleLaunchStorage(lease, Number(pid), Number(status), { expectedStartTime: expected });
    }
  } catch { /* fail closed below */ }
  if (!ok) {
    console.warn(action === "bind"
      ? "[subagent storage] reservation could not be bound; worker not started"
      : "[subagent storage] liveness unproven; reservation retained");
    process.exitCode = 1;
  }
}
