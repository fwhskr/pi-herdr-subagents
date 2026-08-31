import type { CompletionResult } from "./completion.ts";
import type { PaneInspection } from "./lifecycle.ts";

/**
 * UI-neutral lifecycle boundary for a running subagent.
 *
 * Providers own the process/session transport. Callers own presentation and
 * decide when a completed session should be removed from the UI. The Herdr
 * implementation is kept in `herdr-provider.ts`; a desktop worker can provide
 * the same contract without importing either Herdr or TUI code.
 */
export interface SubagentProviderSession {
  /** Provider-owned identifier (a pane id for Herdr, another handle elsewhere). */
  readonly id: string;
  readonly name: string;
}

export interface SubagentProviderLaunch {
  /** Command or argv representation understood by the provider implementation. */
  readonly command: string;
  readonly scriptPath?: string;
  readonly scriptPreamble?: string;
}

export interface SubagentProviderSpawnRequest {
  readonly name: string;
  readonly task?: string;
  /** Reuse an already-created provider session, when the caller owns one. */
  readonly sessionId?: string;
  /** Provider-specific readiness grace before the launch callback runs. */
  readonly readyDelayMs?: number;
  /** Build the launch only after the provider has allocated its session handle. */
  readonly buildLaunch: (session: SubagentProviderSession) => SubagentProviderLaunch;
}

export interface SubagentProviderMonitorOptions {
  readonly signal: AbortSignal;
  readonly sessionFile?: string;
  readonly sentinelFile?: string;
  readonly intervalMs?: number;
  readonly paneDisappearanceGraceMs?: number;
  readonly onPaneInspection?: (inspection: PaneInspection, observedAt: number) => void;
  readonly onTick?: (elapsedSeconds: number) => void;
}

export interface SubagentProviderCollectedResult {
  /** Provider output captured after completion, suitable for a harness summary. */
  readonly output: string;
}

export interface SubagentSessionProvider {
  /** Stable provider id used for diagnostics and future provider selection. */
  readonly id: string;
  readonly name: string;

  /** Availability is checked when a launch is requested, not while importing code. */
  isAvailable(): boolean;
  setupHint(): string;

  /** Allocate, launch, and return a provider-owned session handle. */
  spawn(request: SubagentProviderSpawnRequest): Promise<SubagentProviderSession>;

  /** Wait for completion evidence and report the provider-neutral outcome. */
  monitor(
    session: SubagentProviderSession,
    options: SubagentProviderMonitorOptions,
  ): Promise<CompletionResult>;

  /** Request interruption of the active turn/process. */
  interrupt(session: SubagentProviderSession): void;

  /** Collect provider output after monitor reports completion. */
  collectResult(
    session: SubagentProviderSession,
    completion: CompletionResult,
  ): Promise<SubagentProviderCollectedResult>;

  /** Release the provider-owned session surface/process. */
  close(session: SubagentProviderSession): void;
}

/** Shell-safe quoting shared by command builders and provider implementations. */
export function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}
