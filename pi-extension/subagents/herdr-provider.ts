import {
  closePane,
  createSubagentPane,
  inspectPane,
  interruptPane,
  isTerminalAvailable,
  readPane,
  terminalSetupHint,
  readPaneAsync,
  runScriptInPane,
  setPaneTask,
} from "./terminal.ts";
import { waitForCompletion } from "./completion.ts";
import type { PaneInspection } from "./lifecycle.ts";
import type { CompletionResult } from "./completion.ts";
import type {
  SubagentProviderCollectedResult,
  SubagentProviderMonitorOptions,
  SubagentProviderSession,
  SubagentProviderSpawnRequest,
  SubagentSessionProvider,
} from "./session-provider.ts";

export interface HerdrSessionProviderOperations {
  isAvailable: () => boolean;
  setupHint: () => string;
  createSubagentPane: (name: string) => string;
  runScriptInPane: (
    paneId: string,
    command: string,
    options?: { scriptPath?: string; scriptPreamble?: string },
  ) => string;
  setPaneTask: (paneId: string, task: string) => void;
  readPane: (paneId: string, lines?: number) => string;
  readPaneAsync: (paneId: string, lines?: number) => Promise<string>;
  inspectPane: (paneId: string) => Promise<PaneInspection>;
  interruptPane: (paneId: string) => void;
  closePane: (paneId: string) => void;
}

const defaultOperations: HerdrSessionProviderOperations = {
  isAvailable: isTerminalAvailable,
  setupHint: terminalSetupHint,
  createSubagentPane,
  runScriptInPane,
  setPaneTask,
  readPane,
  readPaneAsync,
  inspectPane,
  interruptPane,
  closePane,
};

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Reference provider for the current terminal path.
 *
 * The provider contract itself has no Herdr dependency. This adapter is the
 * only place where the existing pane transport is selected, so a future
 * desktop provider can replace it without changing session orchestration.
 */
export class HerdrSubagentSessionProvider implements SubagentSessionProvider {
  readonly id = "herdr";
  readonly name = "Herdr terminal";
  private readonly operations: HerdrSessionProviderOperations;

  constructor(operations: HerdrSessionProviderOperations = defaultOperations) {
    this.operations = operations;
  }

  isAvailable(): boolean {
    return this.operations.isAvailable();
  }

  setupHint(): string {
    return this.operations.setupHint();
  }

  async spawn(request: SubagentProviderSpawnRequest): Promise<SubagentProviderSession> {
    const sessionId = request.sessionId ?? this.operations.createSubagentPane(request.name);
    const session: SubagentProviderSession = { id: sessionId, name: request.name };

    try {
      if (request.task !== undefined) {
        this.operations.setPaneTask(session.id, request.task);
      }
      if (!request.sessionId) {
        const readyDelayMs = Math.max(0, request.readyDelayMs ?? 0);
        if (readyDelayMs > 0) await delay(readyDelayMs);
      }
      const launch = request.buildLaunch(session);
      this.operations.runScriptInPane(session.id, launch.command, {
        ...(launch.scriptPath ? { scriptPath: launch.scriptPath } : {}),
        ...(launch.scriptPreamble ? { scriptPreamble: launch.scriptPreamble } : {}),
      });
      return session;
    } catch (error) {
      // Do not leave a newly allocated terminal surface behind when command
      // construction or delivery fails. A caller-owned session is untouched.
      if (!request.sessionId) {
        try {
          this.operations.closePane(session.id);
        } catch {
          // Preserve the original launch error.
        }
      }
      throw error;
    }
  }

  monitor(
    session: SubagentProviderSession,
    options: SubagentProviderMonitorOptions,
  ): Promise<CompletionResult> {
    return waitForCompletion(options.signal, {
      intervalMs: Math.max(1, options.intervalMs ?? 1000),
      sessionFile: options.sessionFile,
      sentinelFile: options.sentinelFile,
      paneDisappearanceGraceMs: options.paneDisappearanceGraceMs,
      readTerminalTail: () => this.operations.readPaneAsync(session.id, 5),
      inspectPane: () => this.operations.inspectPane(session.id),
      onPaneInspection: options.onPaneInspection,
      onTick: options.onTick,
    });
  }

  interrupt(session: SubagentProviderSession): void {
    this.operations.interruptPane(session.id);
  }

  async collectResult(
    session: SubagentProviderSession,
    _completion: CompletionResult,
  ): Promise<SubagentProviderCollectedResult> {
    try {
      return { output: this.operations.readPane(session.id, 200) };
    } catch {
      // Completion evidence may be published while a pane is closing. The
      // session file/sidecar remains the authoritative fallback for callers.
      return { output: "" };
    }
  }

  close(session: SubagentProviderSession): void {
    this.operations.closePane(session.id);
  }
}

export function createHerdrSubagentSessionProvider(
  operations: HerdrSessionProviderOperations = defaultOperations,
): HerdrSubagentSessionProvider {
  return new HerdrSubagentSessionProvider(operations);
}

/** Explicit alias for callers that describe the Herdr path as terminal. */
export const createTerminalSubagentSessionProvider = createHerdrSubagentSessionProvider;
