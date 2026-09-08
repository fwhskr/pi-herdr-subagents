import { existsSync, readFileSync, rmSync } from "node:fs";
import { MISSING_PANE_DEBOUNCE_MS, MISSING_PANE_ERROR } from "./lifecycle.ts";

const ABORT_MESSAGE = "Aborted while waiting for subagent to finish";
const TERMINAL_SENTINEL = /__SUBAGENT_DONE_(\d+)__/;
export const WORKER_PROCESS_DIED_ERROR = "subagent worker process died (no exit sidecar)";

function parseProcessId(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value !== "string") return undefined;
  const match = value.trim().match(/^(?:Some\(\s*(\d+)\s*\)|(\d+))$/);
  if (!match) return undefined;
  const parsed = Number(match[1] ?? match[2]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function isProcessAliveInProc(pid: number): boolean {
  // The worker probe is Linux-specific. On another host, do not turn an
  // unavailable /proc filesystem into a false worker-death report.
  return process.platform !== "linux" || existsSync(`/proc/${pid}`);
}

function workerIdentity(inspection: import("./lifecycle.ts").PaneInspection): {
  pid?: number;
  pgid?: number;
} {
  if (inspection.kind !== "present") return {};
  const raw = inspection as unknown as Record<string, unknown>;
  return {
    pid: parseProcessId(raw.workerPid) ?? parseProcessId(raw.worker_pid),
    pgid: parseProcessId(raw.workerPgid) ??
      parseProcessId(raw.worker_pgid) ??
      parseProcessId(raw.pgid),
  };
}

function workerProcessDied(
  inspection: import("./lifecycle.ts").PaneInspection,
  processExists: (pid: number) => boolean,
): boolean {
  const { pgid, pid } = workerIdentity(inspection);
  // Prefer Herdr's foreground process group: it identifies the pi worker even
  // when the launch shell remains alive after pi exits.
  const workerId = pgid ?? pid;
  if (workerId == null) return false;
  try {
    return !processExists(workerId);
  } catch {
    // A failed /proc read is unknown, not evidence of worker death.
    return false;
  }
}

export interface CompletionResult {
  reason: "done" | "ping" | "sentinel" | "error";
  exitCode: number;
  /** The child completed its one-shot report-only continuation after a time warning. */
  wrapup?: boolean;
  /** Keep the live pane available for inspection after a hard worker exit. */
  preservePane?: boolean;
  ping?: { name: string; message: string };
  errorMessage?: string;
}

export interface CompletionOptions {
  intervalMs: number;
  readTerminalTail: () => Promise<string>;
  inspectPane?: () => Promise<import("./lifecycle.ts").PaneInspection>;
  /** Injectable for unit tests; production uses the host /proc probe. */
  processExists?: (pid: number) => boolean;
  /** Bounded artifact grace after explicit pane disappearance. Default: 500ms. */
  paneDisappearanceGraceMs?: number;
  onPaneInspection?: (
    inspection: import("./lifecycle.ts").PaneInspection,
    observedAt: number,
  ) => void;
  sessionFile?: string;
  sentinelFile?: string;
  onTick?: (elapsedSeconds: number) => void;
}

export function interpretExitSidecar(data: unknown): CompletionResult {
  const payload = data as {
    type?: unknown;
    name?: unknown;
    message?: unknown;
    errorMessage?: unknown;
    wrapup?: unknown;
  };

  if (payload?.type === "ping") {
    return {
      reason: "ping",
      exitCode: 0,
      ping: {
        name: typeof payload.name === "string" ? payload.name : "subagent",
        message: typeof payload.message === "string" ? payload.message : "",
      },
    };
  }

  if (payload?.type === "error") {
    const errorMessage =
      typeof payload.errorMessage === "string" && payload.errorMessage.trim()
        ? payload.errorMessage
        : "Subagent exited with stopReason=error (no errorMessage in sidecar).";
    return { reason: "error", exitCode: 1, errorMessage };
  }

  if (payload?.type === "done") {
    return { reason: "done", exitCode: 0, ...(payload.wrapup === true ? { wrapup: true } : {}) };
  }

  return {
    reason: "error",
    exitCode: 1,
    errorMessage: "Invalid subagent completion sidecar: unsupported payload type.",
  };
}

function consumeExitSidecar(sessionFile: string | undefined): CompletionResult | null {
  if (!sessionFile) return null;

  const exitFile = `${sessionFile}.exit`;
  if (!existsSync(exitFile)) return null;

  try {
    const payload = JSON.parse(readFileSync(exitFile, "utf8")) as {
      type?: unknown;
      stopReason?: unknown;
    };
    const result = interpretExitSidecar(payload);
    rmSync(exitFile, { force: true });
    return payload.type === "error" && payload.stopReason !== "error"
      ? { ...result, preservePane: true }
      : result;
  } catch {
    // The child may still be writing the file. Retry on the next polling cycle.
    return null;
  }
}

function terminalExitCode(screen: string): number | null {
  const match = screen.match(TERMINAL_SENTINEL);
  return match ? Number.parseInt(match[1], 10) : null;
}

function completionArtifact(options: CompletionOptions): CompletionResult | null {
  const sidecar = consumeExitSidecar(options.sessionFile);
  if (sidecar) return sidecar;
  if (options.sentinelFile && existsSync(options.sentinelFile)) {
    return { reason: "sentinel", exitCode: 0 };
  }
  return null;
}

async function waitForDisappearanceArtifacts(
  signal: AbortSignal,
  options: CompletionOptions,
): Promise<CompletionResult | null> {
  const immediate = completionArtifact(options);
  if (immediate) return immediate;

  const graceMs = Math.max(0, options.paneDisappearanceGraceMs ?? 500);
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    await abortableDelay(Math.min(25, remaining), signal);
    const result = completionArtifact(options);
    if (result) return result;
  }
  return null;
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error(ABORT_MESSAGE));

  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error(ABORT_MESSAGE));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function waitForCompletion(
  signal: AbortSignal,
  options: CompletionOptions,
): Promise<CompletionResult> {
  const startedAt = Date.now();
  let missingPaneDetectedAt: number | undefined;

  for (;;) {
    if (signal.aborted) throw new Error(ABORT_MESSAGE);

    const sidecarResult = consumeExitSidecar(options.sessionFile);
    if (sidecarResult) return sidecarResult;

    if (options.sentinelFile && existsSync(options.sentinelFile)) {
      return { reason: "sentinel", exitCode: 0 };
    }

    try {
      const exitCode = terminalExitCode(await options.readTerminalTail());
      if (exitCode !== null) return { reason: "sentinel", exitCode };
    } catch {
      // Terminal reads are only sentinel/output probes; Herdr status is polled
      // independently below, even when terminal reads succeed.
    }

    if (options.inspectPane) {
      let inspection: import("./lifecycle.ts").PaneInspection;
      try {
        inspection = await options.inspectPane();
      } catch {
        inspection = { kind: "unavailable", error: "inspectPane threw" };
      }
      const observedAt = Date.now();
      options.onPaneInspection?.(inspection, observedAt);
      if (inspection.kind === "present" && workerProcessDied(
        inspection,
        options.processExists ?? isProcessAliveInProc,
      )) {
        return {
          reason: "error",
          exitCode: 1,
          preservePane: true,
          errorMessage: WORKER_PROCESS_DIED_ERROR,
        };
      }
      if (inspection.kind === "missing") {
        // A single pane_not_found can race Herdr's pane publication/update.
        // Require the miss to persist briefly before declaring evidence lost.
        missingPaneDetectedAt ??= observedAt;
        const racedCompletion = completionArtifact(options);
        if (racedCompletion) return racedCompletion;
        if (observedAt - missingPaneDetectedAt < MISSING_PANE_DEBOUNCE_MS) {
          options.onTick?.(Math.floor((Date.now() - startedAt) / 1000));
          await abortableDelay(options.intervalMs, signal);
          continue;
        }

        // Pane closure and atomic artifact publication are separate operations.
        // Allow a short bounded grace window before declaring evidence lost.
        const delayedCompletion = await waitForDisappearanceArtifacts(signal, options);
        if (delayedCompletion) return delayedCompletion;
        return {
          reason: "error",
          exitCode: 1,
          errorMessage: MISSING_PANE_ERROR,
        };
      }
      missingPaneDetectedAt = undefined;
    }

    options.onTick?.(Math.floor((Date.now() - startedAt) / 1000));
    await abortableDelay(options.intervalMs, signal);
  }
}
