import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { allocateScratch, cancelUnstartedScratch, SCRATCH_BASE, type LaunchScratch } from "./scratch-lifecycle.ts";
import {
  armDispatchDeadline, cancelLaunchStorage, EVENTS_NAME, reserveLaunchStorage, settleMeta, writeAdoptDescriptor,
  type StorageAdmissionOptions, type StorageLease,
} from "./storage-admission.ts";
import { assertSpawnCodeFresh } from "./staleness-tripwire.ts";
import {
  closeHerdrSurface,
  createHerdrSurface,
  createHerdrSurfaceSplit,
  isHerdrAvailable,
  readHerdrScreen,
  readHerdrScreenAsync,
  inspectHerdrPane,
  renameHerdrTab,
  renameHerdrWorkspace,
  reportHerdrPaneTask,
  sendHerdrCommand,
  sendHerdrEscape,
  listHerdrPaneSessions,
  type HerdrPaneSessionReference,
  type HerdrReadSource,
} from "./herdr.ts";

export type PaneId = string;
export type SplitDirection = "right" | "down";

/**
 * Where a subagent surface should be created:
 *   - `"tab"`   — a brand-new tab (default)
 *   - `"right"` — split the orchestrator pane to the right
 *   - `"down"`  — split the orchestrator pane below
 */
export type SubagentLayout = "tab" | SplitDirection;

const SETUP_HINT = "Start pi inside herdr (`herdr`, then run `pi`).";

/**
 * Parse the `PI_SUBAGENT_LAYOUT` env var into a {@link SubagentLayout}.
 * Accepted values (case-sensitive, trimmed): `split`, `split:right` (both map
 * to a right-hand split), `split:down` (split below). Anything else — unset,
 * empty, or unknown — falls back to the default `tab`.
 */
export function parseSubagentLayout(raw?: string): SubagentLayout {
  const value = (raw ?? "").trim();
  if (value === "split" || value === "split:right") return "right";
  if (value === "split:down") return "down";
  return "tab";
}

/** Read `PI_SUBAGENT_LAYOUT` from the provided environment (defaults to the process env). */
export function resolveSubagentLayout(env: Record<string, string | undefined> = process.env): SubagentLayout {
  return parseSubagentLayout(env.PI_SUBAGENT_LAYOUT);
}

/** Create the surface for a subagent according to the requested layout. */
export function createSubagentSurface(name: string, layout: SubagentLayout = "tab"): PaneId {
  assertTerminalAvailable();
  return layout === "tab" ? createSubagentPane(name) : splitCurrentPane(name, layout);
}

export function isTerminalAvailable(): boolean {
  return isHerdrAvailable();
}

export function terminalSetupHint(): string {
  return SETUP_HINT;
}

function assertTerminalAvailable(): void {
  if (!isTerminalAvailable()) throw new Error(`herdr is not available. ${SETUP_HINT}`);
}

export function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/** Create a new herdr tab and return its root pane ID. */
export function createSubagentPane(name: string): PaneId {
  assertTerminalAvailable();
  return createHerdrSurface(name);
}

/** Split the current herdr pane and return the child pane ID. */
export function splitCurrentPane(name: string, direction: SplitDirection): PaneId {
  assertTerminalAvailable();
  return createHerdrSurfaceSplit(name, direction);
}

export function renameCurrentTab(title: string): void {
  assertTerminalAvailable();
  renameHerdrTab(title);
}

export function renameCurrentWorkspace(title: string): void {
  assertTerminalAvailable();
  renameHerdrWorkspace(title);
}

export function runInPane(paneId: PaneId, command: string): void {
  assertTerminalAvailable();
  sendHerdrCommand(paneId, command);
}

export function interruptPane(paneId: PaneId): void {
  assertTerminalAvailable();
  sendHerdrEscape(paneId);
}

export interface LaunchScriptOptions {
  scriptPath?: string;
  scriptPreamble?: string;
  stderrFile?: string;
  sessionFile?: string;
  /** Synthetic fixture seam; allocation still enforces the .pi boundary. */
  scratchBase?: string;
  /** TASK-283: shared-disk admission (project, class, estimate); CLI/registry seams are fixture-only. */
  storage?: StorageAdmissionOptions;
}

/** Local launch preparation, separately testable without Herdr or a provider. */
export function prepareLaunchScript(command: string, options: LaunchScriptOptions = {}): {
  scriptPath: string; scratch: LaunchScratch; storage: StorageLease;
} {
  // Existing drivers already supply this generated comment; no entrypoint widening.
  const session = options.sessionFile ?? options.scriptPreamble?.match(/^# Session: (.+)$/m)?.[1];
  // TASK-283: reserve a pending handoff lease BEFORE any scratch/export/fork; refusal allocates nothing.
  const storage = reserveLaunchStorage(options.scratchBase ?? SCRATCH_BASE, options.storage);
  let scratch: LaunchScratch;
  try {
    scratch = allocateScratch(session && isAbsolute(session) ? session : null, { scratchBase: options.scratchBase });
  } catch (error) {
    cancelLaunchStorage(storage);
    throw error;
  }
  const scriptPath = options.scriptPath ?? join(scratch.scratchRoot, "launch.sh");
  try {
    mkdirSync(dirname(scriptPath), { recursive: true });

    // L-334: replace inherited prompt-capable transport settings before any
    // preamble/worker command, for every harness and the separate resume path.
    // Child-process backstop only: this does not change the pane's parent shell.
    const scriptLines = [
      "#!/bin/bash",
      "export GIT_SSH_COMMAND='/usr/bin/ssh -o BatchMode=yes -o NumberOfPasswordPrompts=0'",
      "export SSH_ASKPASS=/bin/false SSH_ASKPASS_REQUIRE=never DISPLAY=",
    ];
    if (options.scriptPreamble) scriptLines.push(options.scriptPreamble.trimEnd());
    // Capture stderr outside ephemeral scratch while still showing it in the pane.
    if (options.stderrFile) {
      scriptLines.push(`exec 2> >(tee -a ${shellQuote(options.stderrFile)} >&2)`);
    }
    scriptLines.push(command);
    const workerPath = join(scratch.scratchRoot, "worker.sh");
    let delimiter = `__PI_WORKER_${scratch.launchId.replaceAll("-", "_")}__`;
    while (scriptLines.join("\n").split("\n").includes(delimiter)) delimiter += "_";
    const helper = `${shellQuote(process.execPath)} ${shellQuote(fileURLToPath(new URL("./scratch-lifecycle.ts", import.meta.url)))} --scratch-lifecycle`;
    // Token-bearing adopt request: 0600 beside the scratch lease, never TMPDIR/argv/env.
    const descriptor = writeAdoptDescriptor(storage, scratch.leasePath, scratch.scratchRoot);
    const launchRoot = dirname(scratch.leasePath);
    const storageHelper = `${shellQuote(process.execPath)} ${shellQuote(fileURLToPath(new URL("./storage-admission.ts", import.meta.url)))} --storage-admission`;
    // The core runs in the pane's foreground job: it binds this job, monitors owned growth
    // and only then starts the worker, which keeps the terminal, job control and SIGWINCH.
    const core = [process.execPath, storage.cli, "run", ...storage.flags, "--attach", "job", "--request-fd", "3",
      "--event-file", join(launchRoot, EVENTS_NAME), "--", "bash", workerPath].map(shellQuote).join(" ");
    // Scratch closes first; the reservation settles from core answers only (fail closed).
    const close = `status=$?; ${helper} close ${shellQuote(scratch.leasePath)} "$$"; ${storageHelper} settle ${shellQuote(settleMeta(storage))} ${shellQuote(descriptor)} "$status"; exit "$status"`;
    // Keep custody in a supervisor: preamble exits/execs cannot replace the EXIT trap.
    writeFileSync(scriptPath, [
      "#!/bin/bash",
      "export GIT_SSH_COMMAND='/usr/bin/ssh -o BatchMode=yes -o NumberOfPasswordPrompts=0'",
      "export SSH_ASKPASS=/bin/false SSH_ASKPASS_REQUIRE=never DISPLAY=",
      `export TMPDIR=${shellQuote(scratch.scratchRoot)}`,
      `trap ${shellQuote(close)} EXIT`,
      `${helper} start ${shellQuote(scratch.leasePath)} "$$"`,
      // An explicitly retained launch script keeps session/command metadata;
      // the executable worker copy is always ephemeral.
      `cat > ${shellQuote(workerPath)} <<${shellQuote(delimiter)}`,
      ...scriptLines,
      delimiter,
      `${core} 3< ${shellQuote(descriptor)}`,
      "",
    ].join("\n"), { mode: 0o700 });
    return { scriptPath, scratch, storage };
  } catch (error) {
    cancelUnstartedScratch(scratch);
    cancelLaunchStorage(storage);
    throw error;
  }
}

export function runScriptInPane(
  paneId: PaneId,
  command: string,
  options?: LaunchScriptOptions,
): string {
  // L-357: refuse pre-drift code before writing or allocating any launch data.
  assertSpawnCodeFresh(`runScriptInPane(${paneId})`);
  const launch = prepareLaunchScript(command, options);
  try {
    runInPane(paneId, `TMPDIR=${shellQuote(launch.scratch.scratchRoot)} bash ${shellQuote(launch.scriptPath)}`);
    // A job that never binds is cancelled with the token after one bounded deadline.
    void armDispatchDeadline(launch.storage);
    return launch.scriptPath;
  } catch (error) {
    cancelUnstartedScratch(launch.scratch);
    cancelLaunchStorage(launch.storage);
    throw error;
  }
}

export function readPane(
  paneId: PaneId,
  lines = 50,
  source: HerdrReadSource = "visible",
): string {
  assertTerminalAvailable();
  return readHerdrScreen(paneId, lines, source);
}

export async function readPaneAsync(
  paneId: PaneId,
  lines = 50,
  source: HerdrReadSource = "visible",
): Promise<string> {
  assertTerminalAvailable();
  return readHerdrScreenAsync(paneId, lines, source);
}

export type { PaneInspection, HerdrAgentStatus } from "./lifecycle.ts";

export async function inspectPane(paneId: PaneId): Promise<import("./lifecycle.ts").PaneInspection> {
  assertTerminalAvailable();
  const result = await inspectHerdrPane(paneId);
  if (result.kind === "present") {
    return { ...result, observedAt: Date.now() };
  }
  return result;
}

export function closePane(paneId: PaneId): void {
  assertTerminalAvailable();
  closeHerdrSurface(paneId);
}

export function listPaneSessionReferences(): HerdrPaneSessionReference[] {
  if (!isTerminalAvailable()) return [];
  return listHerdrPaneSessions();
}

export function setPaneTask(paneId: PaneId, task: string): void {
  if (!isTerminalAvailable()) return;
  reportHerdrPaneTask(paneId, task);
}
