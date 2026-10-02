import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import subagentDoneExtension, {
  resolveFallbackAwareExit,
} from "../pi-extension/subagents/subagent-done.ts";

// TASK-23 — a delegated lane on a fully-cooling provider chain must be able to
// outwait a bounded horizon instead of ending in seconds. The live
// agent-fallback-chain extension appends `agent-fallback-terminal` with
// "every chain model is cooling down; auto-resume ..." and arms its own
// in-process resume timer at the soonest cooldown. The one-shot subagent
// runtime used to read that terminal entry as "chain exhausted" and exit at
// once, killing the pane (and the unref'd resume timer with it). These fixtures
// drive the real extension path.

interface Notification {
  message: string;
  type?: string;
}

const ERROR = "Codex error: The usage limit has been reached";
const ERROR_ASSISTANT = { role: "assistant", stopReason: "error", errorMessage: ERROR };
const COOLING_REASON =
  "every chain model is cooling down; auto-resume on opencode-go/deepseek-v4.1-flash at 10:43:22 PM";
const STOPPED_REASON = "no configured fallback is available";

function assistantEntry(errorMessage = ERROR): any {
  return { type: "message", message: { role: "assistant", stopReason: "error", errorMessage } };
}
function custom(customType: string, data: any = {}): any {
  return { type: "custom", customType, data };
}

function createExtensionApi() {
  const eventHandlers = new Map<string, Array<Function>>();
  const registeredTools: any[] = [];
  const api = {
    on(event: string, handler: Function) {
      const handlers = eventHandlers.get(event) ?? [];
      handlers.push(handler);
      eventHandlers.set(event, handlers);
    },
    registerTool(tool: any) {
      registeredTools.push(tool);
    },
    registerCommand() {},
    registerMessageRenderer() {},
    registerShortcut() {},
    sendUserMessage() {},
    sendMessage() {},
    getAllTools() {
      return [];
    },
  } as any;
  return { api, eventHandlers, registeredTools };
}

const originals = {
  autoExit: process.env.PI_SUBAGENT_AUTO_EXIT,
  session: process.env.PI_SUBAGENT_SESSION,
  agent: process.env.PI_SUBAGENT_AGENT,
  agentDir: process.env.PI_CODING_AGENT_DIR,
  guardMs: process.env.PI_SUBAGENT_FALLBACK_GUARD_MS,
  coolingMs: process.env.PI_SUBAGENT_FALLBACK_COOLING_WAIT_MS,
  id: process.env.PI_SUBAGENT_ID,
  activity: process.env.PI_SUBAGENT_ACTIVITY_FILE,
  resumeInput: process.env.PI_SUBAGENT_RESUME_INPUT,
  autoExitRearm: process.env.PI_SUBAGENT_AUTO_EXIT_REARM,
};

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("TASK-23 cooling-chain wait (subagent runtime)", () => {
  let dir: string;
  let releases: Array<() => void> = [];

  beforeEach(() => {
    delete process.env.PI_SUBAGENT_ID;
    delete process.env.PI_SUBAGENT_ACTIVITY_FILE;
    delete process.env.PI_SUBAGENT_RESUME_INPUT;
    delete process.env.PI_SUBAGENT_AUTO_EXIT_REARM;
    process.env.PI_SUBAGENT_AUTO_EXIT = "1";
    process.env.PI_SUBAGENT_FALLBACK_GUARD_MS = "60";
    process.env.PI_SUBAGENT_FALLBACK_COOLING_WAIT_MS = "600";
    dir = mkdtempSync(join(tmpdir(), "task23-cooling-"));
    mkdirSync(join(dir, "agents"), { recursive: true });
    writeFileSync(
      join(dir, "agents", "deep.md"),
      "---\nmodel: openai-codex/gpt-6-astra\nthinking: high\n" +
        "fallbacks:\n  - provider: deepseek\n    model: deepseek-flash\n    thinking: high\n---\nbody\n",
    );
    process.env.PI_CODING_AGENT_DIR = dir;
    process.env.PI_SUBAGENT_AGENT = "deep";
    releases = [];
  });

  afterEach(() => {
    for (const release of releases) release();
    releases = [];
    restoreEnv("PI_SUBAGENT_AUTO_EXIT", originals.autoExit);
    restoreEnv("PI_SUBAGENT_SESSION", originals.session);
    restoreEnv("PI_SUBAGENT_AGENT", originals.agent);
    restoreEnv("PI_CODING_AGENT_DIR", originals.agentDir);
    restoreEnv("PI_SUBAGENT_FALLBACK_GUARD_MS", originals.guardMs);
    restoreEnv("PI_SUBAGENT_FALLBACK_COOLING_WAIT_MS", originals.coolingMs);
    restoreEnv("PI_SUBAGENT_ID", originals.id);
    restoreEnv("PI_SUBAGENT_ACTIVITY_FILE", originals.activity);
    restoreEnv("PI_SUBAGENT_RESUME_INPUT", originals.resumeInput);
    restoreEnv("PI_SUBAGENT_AUTO_EXIT_REARM", originals.autoExitRearm);
    rmSync(dir, { recursive: true, force: true });
  });

  function boot(entries: any[]) {
    const priorExit = process.listeners("exit");
    const priorUncaught = process.listeners("uncaughtException");
    releases.push(() => {
      for (const h of process.listeners("exit")) {
        if (!priorExit.includes(h)) process.off("exit", h as () => void);
      }
      for (const h of process.listeners("uncaughtException")) {
        if (!priorUncaught.includes(h)) process.off("uncaughtException", h as (e: Error) => void);
      }
    });
    const sessionFile = join(dir, "child.jsonl");
    process.env.PI_SUBAGENT_SESSION = sessionFile;
    const { api, eventHandlers } = createExtensionApi();
    subagentDoneExtension(api);
    const notifications: Notification[] = [];
    const ctx: any = {
      shutdowns: 0,
      cwd: dir,
      sessionManager: { getEntries: () => entries },
      ui: {
        notify(message: string, type?: string) {
          notifications.push({ message, type });
        },
        setWidget() {},
      },
      shutdown() {
        ctx.shutdowns += 1;
      },
    };
    return {
      ctx,
      notifications,
      sessionFile,
      fire(event: string, payload: any = {}) {
        for (const handler of eventHandlers.get(event) ?? []) handler(payload, ctx);
      },
      settle(messages: any[]) {
        this.fire("agent_end", { messages });
        this.fire("agent_settled", { type: "agent_settled" });
      },
    };
  }

  function sidecarOf(child: ReturnType<typeof boot>): any | null {
    const file = `${child.sessionFile}.exit`;
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  }

  it("RED: an all-cooling chain waits for the horizon instead of ending in seconds", () => {
    const child = boot([
      assistantEntry(),
      custom("agent-fallback", {}),
      custom("agent-fallback-terminal", { reason: COOLING_REASON }),
    ]);
    child.settle([ERROR_ASSISTANT]);
    assert.equal(
      child.ctx.shutdowns,
      0,
      "a scheduled cooling auto-resume must keep the pane alive, not exit immediately",
    );
    assert.equal(sidecarOf(child), null, "no failure sidecar while the cooldown wait is armed");
    child.fire("turn_start", { turnIndex: 1 }); // the extension's resume fires
    assert.equal(child.ctx.shutdowns, 0, "the resumed turn must not be killed");
  });

  it("the cooling wait is interruptible by the scheduled resume (turn_start)", async () => {
    const child = boot([
      assistantEntry(),
      custom("agent-fallback-terminal", { reason: COOLING_REASON }),
    ]);
    child.settle([ERROR_ASSISTANT]);
    assert.equal(child.ctx.shutdowns, 0);
    child.fire("turn_start", { turnIndex: 1 });
    await delay(800); // longer than the 600 ms cooling budget
    assert.equal(child.ctx.shutdowns, 0, "turn_start cancels the cooling wait");
    assert.equal(sidecarOf(child), null);
  });

  it("the cooling wait is bounded: no resume ends with the original provider error", async () => {
    const child = boot([
      assistantEntry(),
      custom("agent-fallback-terminal", { reason: COOLING_REASON }),
    ]);
    child.settle([ERROR_ASSISTANT]);
    assert.equal(child.ctx.shutdowns, 0);
    await delay(1400); // 600 ms budget + poll slack
    assert.equal(child.ctx.shutdowns, 1, "an absurd horizon still ends the lane");
    const sidecar = sidecarOf(child);
    assert.equal(sidecar?.type, "error");
    assert.equal(sidecar?.errorMessage, ERROR);
  });

  it("a genuine outage (non-cooling terminal) still ends immediately", () => {
    const child = boot([
      assistantEntry(),
      custom("agent-fallback", {}),
      custom("agent-fallback-terminal", { reason: STOPPED_REASON }),
    ]);
    child.settle([ERROR_ASSISTANT]);
    assert.equal(child.ctx.shutdowns, 1, "no scheduled resume means no wait");
    assert.equal(sidecarOf(child)?.errorMessage, ERROR);
  });

  it("a healthy primary finishes normally", () => {
    const child = boot([]);
    child.settle([{ role: "assistant", stopReason: "stop" }]);
    assert.equal(child.ctx.shutdowns, 1);
    assert.equal(sidecarOf(child)?.type, "done");
  });

  it("a live fallback (pending recovery) still defers as before", () => {
    const child = boot([assistantEntry(), custom("agent-fallback", { status: "continuation-requested" })]);
    child.settle([ERROR_ASSISTANT]);
    assert.equal(child.ctx.shutdowns, 0, "a queued recovery must defer");
    child.fire("turn_start", { turnIndex: 1 });
    assert.equal(child.ctx.shutdowns, 0);
  });

  it("pure decision: an exhausted chain with a scheduled cooling resume waits", () => {
    const decision = resolveFallbackAwareExit({
      recovery: "exhausted",
      failoverEligible: true,
      hasDeclaredFallback: true,
      coolingScheduled: true,
    } as any);
    assert.equal(decision, "cooling-wait");
  });
});
