import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFile, spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { processIdentity, type ProcessIdentity } from "./scratch-lifecycle.ts";

/**
 * TASK-283: shared-filesystem storage admission for delegated launch preparation.
 *
 * Standalone consumer of the storage-budget CLI (operation as argv[2], one JSON request on
 * stdin or --request-fd, one JSON response on stdout). Nothing here imports the CLI's
 * internals; the executable is run by absolute path and bounded.
 *
 * Flow (accepted foreground-job contract): the launcher reserves a PENDING handoff lease
 * (handoffDigest = sha256 of a private 32-byte token) before any scratch, export or fork.
 * The token lives only in this process and in a 0600 adopt descriptor beside the scratch
 * lease (never TMPDIR, argv or environment). The launch script runs the core in the pane's
 * foreground job (`run --attach job --request-fd 3`); the core binds the job, monitors owned
 * growth and only then lets the worker start with the real terminal. The script's EXIT trap
 * settles from core truth only. Every refusal or indeterminate answer fails closed.
 */
export const STORAGE_BUDGET_CLI = "/home/kris/.pi/agent/skills/using-skills/scripts/storage-budget.mjs";
const NODE = process.execPath; // resolved at load, independent of later execPath swaps
const DEFAULT_TIMEOUT_MS = 10_000;
export const DISPATCH_DEADLINE_MS = 120_000;
const MAX_REFUSAL = 480;
const CLASSES = ["source", "build", "container", "artifact"] as const;
export type StorageClass = (typeof CLASSES)[number];
export const DESCRIPTOR_NAME = "storage-adopt.json";
export const EVENTS_NAME = "storage-events.jsonl";

export interface Producer { pid: number; startTime: string; bootId: string }

export interface StorageAdmissionOptions {
  /** Absolute storage-budget executable; defaults to the tracked shared script. */
  cli?: string;
  /** Isolated (non-production) ledger for fixtures only; production passes no flags. */
  registryRoot?: string;
  /** Standalone policy file for that isolated ledger; requires registryRoot. */
  policy?: string;
  /** Canonical project identity override; otherwise resolved from `cwd`. */
  project?: string;
  cwd?: string;
  class?: StorageClass;
  /** Explicit estimate in bytes; omitted = the core's class default (never zero). */
  estimatedBytes?: number;
  timeoutMs?: number;
  /** Synthetic seams; production uses /proc. */
  readBootId?: () => string | null | undefined;
  identity?: ProcessIdentity;
}

export interface StorageLease {
  cli: string;
  flags: string[];
  production: boolean;
  leaseId: string;
  launchId: string;
  destination: string;
  project: string;
  class: StorageClass;
  producer: Producer;
  timeoutMs: number;
}

/** The token never appears on the public lease object, argv, environment or in TMPDIR. */
const tokens = new WeakMap<StorageLease, string>();

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

function flagsFor(options: Pick<StorageAdmissionOptions, "registryRoot" | "policy">): string[] {
  if (options.policy !== undefined && options.registryRoot === undefined) {
    throw new StorageRefusal("storage admission refused: a policy applies only to an isolated registry root");
  }
  if (options.registryRoot === undefined) return [];
  if (!isAbsolute(options.registryRoot) || (options.policy !== undefined && !isAbsolute(options.policy))) {
    throw new StorageRefusal("storage admission refused: isolated registry/policy paths must be absolute");
  }
  return ["--registry-root", options.registryRoot, ...(options.policy === undefined ? [] : ["--policy", options.policy])];
}

/** Fields this adapter reads from a core response; everything else is ignored. */
interface CoreResponse {
  ok?: unknown; admitted?: unknown; released?: unknown; reason?: unknown; production?: unknown; leaseId?: unknown; handoff?: unknown;
  freeBytes?: unknown; reservedBytes?: unknown; estimatedBytes?: unknown; floorBytes?: unknown;
  query?: unknown; leaseState?: unknown; projectMatches?: unknown;
  lease?: { dispatched?: unknown; handoff?: unknown } | null;
}
type Answer = { response: CoreResponse } | { failure: string };

function parse(op: string, stdout: string, expectProduction: boolean): Answer {
  try {
    const parsed = JSON.parse(stdout);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { failure: `storage-budget ${op} returned unreadable output` };
    // Sanctioned consumers require the central registry in production (and never accept it in fixtures).
    if (parsed.production !== expectProduction) return { failure: `storage-budget ${op} answered from an unexpected registry` };
    return { response: parsed as CoreResponse };
  } catch { return { failure: `storage-budget ${op} returned unreadable output` }; }
}

function call(lease: Pick<StorageLease, "cli" | "flags" | "production" | "timeoutMs">, op: string, request: unknown): Answer {
  if (!isAbsolute(lease.cli) || !existsSync(lease.cli)) return { failure: "storage-budget executable not found" };
  const result = spawnSync(NODE, [lease.cli, op, ...lease.flags], {
    input: JSON.stringify(request), encoding: "utf8", timeout: lease.timeoutMs, killSignal: "SIGKILL", maxBuffer: 64 * 1024,
    stdio: ["pipe", "pipe", "ignore"],
  });
  if (result.error) return { failure: `storage-budget ${op} did not complete (${(result.error as NodeJS.ErrnoException).code ?? "error"})` };
  if (result.status !== 0 && result.status !== 1 && result.status !== 2) return { failure: `storage-budget ${op} exited ${result.status}` };
  return parse(op, result.stdout, lease.production);
}

function callAsync(lease: StorageLease, op: string, request: unknown): Promise<Answer> {
  return new Promise((done) => {
    if (!isAbsolute(lease.cli) || !existsSync(lease.cli)) { done({ failure: "storage-budget executable not found" }); return; }
    try {
      const child = execFile(NODE, [lease.cli, op, ...lease.flags], { encoding: "utf8", timeout: lease.timeoutMs, killSignal: "SIGKILL", maxBuffer: 64 * 1024 },
        (error, stdout) => {
          const code = (error as { code?: unknown } | null)?.code;
          if (error && !(code === 1 || code === 2)) { done({ failure: `storage-budget ${op} did not complete` }); return; }
          done(parse(op, stdout, lease.production));
        });
      child.stdin?.end(JSON.stringify(request));
    } catch { done({ failure: `storage-budget ${op} did not start` }); }
  });
}

const num = (value: unknown): string => (typeof value === "number" && Number.isFinite(value) ? String(value)
  : typeof value === "string" && /^-?\d+$/.test(value) ? value : "unknown");

/** Acquire a pending handoff lease before any scratch/export/fork. Throws StorageRefusal; allocates nothing. */
export function reserveLaunchStorage(scratchBase: string, options: StorageAdmissionOptions = {}): StorageLease {
  const cls = options.class ?? "source";
  if (!CLASSES.includes(cls)) throw new StorageRefusal(`storage admission refused: unknown class ${String(cls).slice(0, 40)}`);
  if (options.estimatedBytes !== undefined && (!Number.isSafeInteger(options.estimatedBytes) || options.estimatedBytes <= 0)) {
    throw new StorageRefusal("storage admission refused: estimate must be a positive integer byte count");
  }
  const flags = flagsFor(options);
  const production = flags.length === 0;
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
  const token = randomBytes(32).toString("hex");
  const handoffDigest = `sha256:${createHash("sha256").update(Buffer.from(token, "hex")).digest("hex")}`;
  const request = {
    destination, project, launchId, class: cls, producer, handoffDigest,
    ...(options.estimatedBytes === undefined ? {} : { estimatedBytes: options.estimatedBytes }),
  };
  const answer = call({ cli, flags, production, timeoutMs }, "reserve", request);
  if ("failure" in answer) throw new StorageRefusal(`storage admission unavailable: ${answer.failure}; launch not started`);
  const r = answer.response;
  if (r.admitted !== true || r.ok === false) {
    const reason = typeof r.reason === "string" ? r.reason.replace(/[^\x20-\x7e]/g, "?").slice(0, 80) : "refused";
    throw new StorageRefusal(`storage admission refused (${reason}): free ${num(r.freeBytes)} reserved ${num(r.reservedBytes)} request ${num(r.estimatedBytes ?? options.estimatedBytes)} floor ${num(r.floorBytes)}`, r);
  }
  if (typeof r.leaseId !== "string" || !/^[\x21-\x7e]{1,200}$/.test(r.leaseId) || (r.handoff !== undefined && r.handoff !== "pending")) {
    throw new StorageRefusal("storage admission unavailable: admitted without a usable pending lease; launch not started", r);
  }
  const lease: StorageLease = { cli, flags, production, leaseId: r.leaseId, launchId, destination, project, class: cls, producer, timeoutMs };
  tokens.set(lease, token);
  return lease;
}

/** Exact adopt request the core reads from fd 3: never contains reserve fields. */
export function adoptRequest(lease: StorageLease, scratchRoot: string): Record<string, unknown> {
  const token = tokens.get(lease);
  if (!token) throw new StorageRefusal("storage admission unavailable: lease token missing; launch not started");
  return {
    leaseId: lease.leaseId, project: lease.project, launchId: lease.launchId,
    handoff: { from: lease.producer, token }, ownedPaths: [scratchRoot],
  };
}

/** Write the 0600 adopt descriptor beside the scratch lease (not in TMPDIR). */
export function writeAdoptDescriptor(lease: StorageLease, leasePath: string, scratchRoot: string): string {
  const path = join(dirname(leasePath), DESCRIPTOR_NAME);
  writeFileSync(path, JSON.stringify(adoptRequest(lease, scratchRoot)), { mode: 0o600, flag: "wx" });
  return path;
}

/** Public, token-free lease metadata the launch script hands to the settle helper. */
export function settleMeta(lease: StorageLease): string {
  const { cli, flags, production, leaseId, launchId, project, timeoutMs } = lease;
  return JSON.stringify({ cli, flags, production, leaseId, launchId, project, timeoutMs });
}

type CancelOutcome = "cancelled" | "gone" | "dispatched" | "retained";

function cancelOutcome(answer: Answer): CancelOutcome {
  if ("failure" in answer) return "retained";
  const r = answer.response;
  if (r.ok === true && r.released === true) return "cancelled";
  if (r.reason === "lease-not-found") return "gone";
  return "retained";
}

function cancelRequest(lease: Pick<StorageLease, "leaseId" | "project" | "launchId">, token: string) {
  return { leaseId: lease.leaseId, reason: "cancelled-before-dispatch", project: lease.project, launchId: lease.launchId, token };
}

/** Cancel a never-dispatched launch with its token. Never throws; false = core did not confirm. */
export function cancelLaunchStorage(lease: StorageLease): boolean {
  try {
    const token = tokens.get(lease);
    if (!token) return false;
    const outcome = cancelOutcome(call(lease, "release", cancelRequest(lease, token)));
    if (outcome === "cancelled" || outcome === "gone") { tokens.delete(lease); return true; }
    return false;
  } catch { return false; }
}

function leaseQuery(answer: Answer): { state: "absent" | "pending" | "dispatched" | "unknown" } {
  if ("failure" in answer) return { state: "unknown" };
  const r = answer.response;
  if (r.ok !== true || r.query !== "lease") return { state: "unknown" };
  if (r.leaseState === "absent") return { state: "absent" };
  if (r.leaseState !== "present" || !r.lease || r.projectMatches !== true) return { state: "unknown" };
  if (r.lease.dispatched === true) return { state: "dispatched" };
  if (r.lease.dispatched === false && r.lease.handoff === "pending") return { state: "pending" };
  return { state: "unknown" };
}

/**
 * One dispatch deadline per launch: if the core never bound the pane job, cancel the pending
 * lease with the token (a later bind is then refused by the core). Single unref'd timer, no polling.
 */
export function armDispatchDeadline(lease: StorageLease, ms: number = DISPATCH_DEADLINE_MS): Promise<CancelOutcome | "skipped"> {
  return new Promise((done) => {
    const timer = setTimeout(async () => {
      try {
        const token = tokens.get(lease);
        if (!token) { done("skipped"); return; }
        const q = leaseQuery(await callAsync(lease, "status", { leaseId: lease.leaseId, project: lease.project }));
        if (q.state === "absent") { tokens.delete(lease); done("gone"); return; }
        if (q.state !== "pending") { done(q.state === "dispatched" ? "dispatched" : "retained"); return; }
        const outcome = cancelOutcome(await callAsync(lease, "release", cancelRequest(lease, token)));
        if (outcome === "cancelled" || outcome === "gone") tokens.delete(lease);
        done(outcome);
      } catch { done("retained"); }
    }, ms);
    timer.unref?.();
  });
}

export type SettleOutcome = "cancelled" | "gone" | "released" | "retained";

/**
 * EXIT-trap settlement from core truth only: first try cancel-before-dispatch with the token
 * (released = never dispatched; not-found = already settled); if the core reports the lease as
 * dispatched, custody moved to the job, so ask for completed/failed release as an in-job caller.
 * Any indeterminate answer keeps the reservation; the descriptor is kept only while the token
 * may still be needed for a pre-dispatch cancel.
 */
export function settleLaunchStorage(metaJson: string, descriptorPath: string, exitStatus: number): SettleOutcome {
  let meta: Pick<StorageLease, "cli" | "flags" | "production" | "leaseId" | "launchId" | "project" | "timeoutMs">;
  let token: string;
  try {
    meta = JSON.parse(metaJson);
    const descriptor = JSON.parse(readFileSync(descriptorPath, "utf8"));
    token = descriptor?.handoff?.token;
    if (descriptor?.leaseId !== meta.leaseId || typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)
      || !Array.isArray(meta.flags) || typeof meta.cli !== "string" || typeof meta.production !== "boolean") return "retained";
  } catch { return "retained"; }
  const drop = () => { try { unlinkSync(descriptorPath); } catch { /* gone */ } };
  try {
    const first = cancelOutcome(call(meta, "release", cancelRequest(meta, token)));
    if (first === "cancelled" || first === "gone") { drop(); return first; }
    const q = leaseQuery(call(meta, "status", { leaseId: meta.leaseId, project: meta.project }));
    if (q.state === "absent") { drop(); return "gone"; }
    if (q.state !== "dispatched") return "retained";
    drop(); // custody moved to the bound job; the token can no longer cancel anything
    const answer = call(meta, "release", {
      leaseId: meta.leaseId, reason: exitStatus === 0 ? "completed" : "failed", project: meta.project, launchId: meta.launchId,
    });
    if ("failure" in answer) return "retained";
    if (answer.response.ok === true && answer.response.released === true) return "released";
    return answer.response.reason === "lease-not-found" ? "gone" : "retained";
  } catch { return "retained"; }
}

// Local helper entry for the generated launch script; never imports the extension.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === "--storage-admission") {
  const [, , , action, meta, descriptor, status] = process.argv;
  const outcome = action === "settle" ? settleLaunchStorage(meta, descriptor, Number(status)) : "retained";
  if (outcome === "retained") {
    console.warn("[subagent storage] settlement unproven; reservation retained");
    process.exitCode = 1;
  }
}
