import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import subagentDoneExtension, { countOutstandingChildren } from "../pi-extension/subagents/subagent-done.ts";
import { __test__ as subagentsTest } from "../pi-extension/subagents/index.ts";
import { createLifecycle } from "../pi-extension/subagents/lifecycle.ts";

// TASK-395 — safety of the pending-child yield deferral (companion to
// test/task236-pending-child-yield.test.ts). While a delegated child is
// outstanding the worker never shuts down and never aborts or suppresses the
// child. Once the registry empties, a result turn re-decides the exit; if no
// result turn arrives, a bounded guard exits so the pane is never stranded.

const ENV_NAMES = [
  "PI_SUBAGENT_AUTO_EXIT",
  "PI_SUBAGENT_AUTO_EXIT_REARM",
  "PI_SUBAGENT_RESUME_INPUT",
  "PI_SUBAGENT_SESSION",
  "PI_SUBAGENT_ID",
  "PI_SUBAGENT_ACTIVITY_FILE",
  "PI_SUBAGENT_PENDING_CHILD_POLL_MS",
] as const;
const originalEnv = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
const tempDirs = new Set<string>();
const releases: Array<() => void> = [];

afterEach(() => {
  for (const release of releases.splice(0)) release();
  for (const name of ENV_NAMES) {
    const value = originalEnv[name];
    if (value == null) delete process.env[name];
    else process.env[name] = value;
  }
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
  (subagentsTest.runningSubagents as Map<string, any>).clear();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.add(dir);
  return dir;
}

const POLL_MS = 5;

function bootWorker(opts: { autoExit?: boolean } = {}) {
  for (const name of ENV_NAMES) delete process.env[name];
  if (opts.autoExit ?? true) process.env.PI_SUBAGENT_AUTO_EXIT = "1";
  process.env.PI_SUBAGENT_PENDING_CHILD_POLL_MS = String(POLL_MS);
  const sessionFile = join(tempDir("task395-worker-"), "worker.jsonl");
  writeFileSync(sessionFile, "session header\n");
  process.env.PI_SUBAGENT_SESSION = sessionFile;

  const priorExit = process.listeners("exit");
  const priorUncaught = process.listeners("uncaughtException");
  const handlers = new Map<string, Function[]>();
  subagentDoneExtension({
    on(event: string, handler: Function) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerTool() {},
    registerCommand() {},
    registerMessageRenderer() {},
    registerShortcut() {},
    sendUserMessage() {},
    sendMessage() {},
    getAllTools() { return []; },
  } as any);

  const ctx: any = {
    shutdowns: 0,
    cwd: tempDir("task395-cwd-"),
    sessionManager: { getEntries: () => [] },
    ui: { notify() {}, setWidget() {} },
    shutdown() { ctx.shutdowns += 1; },
  };
  const fire = (event: string, payload: any = {}) => {
    for (const handler of handlers.get(event) ?? []) handler(payload, ctx);
  };
  const worker = {
    ctx,
    sessionFile,
    fire,
    settle(messages: any[]) {
      fire("agent_end", { messages });
      fire("agent_settled", { type: "agent_settled" });
    },
    release() {
      fire("session_shutdown", { reason: "test" });
      for (const h of process.listeners("exit")) {
        if (!priorExit.includes(h)) process.off("exit", h as () => void);
      }
      for (const h of process.listeners("uncaughtException")) {
        if (!priorUncaught.includes(h)) process.off("uncaughtException", h as (e: Error) => void);
      }
    },
  };
  releases.push(() => worker.release());
  return worker;
}

function outstandingChild() {
  return {
    id: "grandchild-1",
    name: "Grandchild",
    task: "bounded delegated task",
    surface: "pane-grandchild",
    startTime: Date.now(),
    sessionFile: join(tempDir("task395-grandchild-"), "grandchild.jsonl"),
    cli: "pi",
    interactive: false,
    lifecycle: createLifecycle(Date.now()),
    abortController: new AbortController(),
  };
}

const yieldTurn = [
  { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Delegated; waiting for the child." }] },
];
const finalTurn = [
  { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Final report." }] },
];

/** Observable-condition wait with a hard deadline (no blind sleep as proof). */
async function waitFor(condition: () => boolean, deadlineMs = 2000): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return condition();
}

/** Let the guard poll several times (well past its settle ticks). */
function pollWindow(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, POLL_MS * 12));
}

describe("TASK-395 pending-child yield guard", () => {
  it("counts the shared runtime registry the subagent tool writes", () => {
    const running = subagentsTest.runningSubagents as Map<string, any>;
    assert.equal(countOutstandingChildren(), 0);
    running.set("grandchild-1", outstandingChild());
    assert.equal(countOutstandingChildren(), 1);
  });

  it("never shuts down, aborts or suppresses an outstanding child while deferring", async () => {
    const running = subagentsTest.runningSubagents as Map<string, any>;
    const child = outstandingChild();
    running.set(child.id, child);
    const worker = bootWorker();
    worker.fire("agent_start", {});
    worker.settle(yieldTurn);
    await pollWindow();
    assert.equal(worker.ctx.shutdowns, 0);
    assert.equal(child.abortController.signal.aborted, false, "the pending child is not aborted");
    assert.equal(child.lifecycle.delivery, "pending", "the pending child's result is not suppressed");
    assert.equal(running.has(child.id), true);
    assert.equal(existsSync(`${worker.sessionFile}.exit`), false);
  });

  it("exits once through the bounded guard when the registry empties without a result turn", async () => {
    const running = subagentsTest.runningSubagents as Map<string, any>;
    running.set("grandchild-1", outstandingChild());
    const worker = bootWorker();
    worker.fire("agent_start", {});
    worker.settle(yieldTurn);
    assert.equal(worker.ctx.shutdowns, 0);
    running.delete("grandchild-1");
    assert.equal(await waitFor(() => worker.ctx.shutdowns === 1), true, "guard exits after the registry empties");
    await pollWindow();
    assert.equal(worker.ctx.shutdowns, 1, "exactly one exit");
    assert.equal(existsSync(`${worker.sessionFile}.exit`), true);
  });

  it("a delivered result turn cancels the guard and its own settle exits exactly once", async () => {
    const running = subagentsTest.runningSubagents as Map<string, any>;
    running.set("grandchild-1", outstandingChild());
    const worker = bootWorker();
    worker.fire("agent_start", {});
    worker.settle(yieldTurn);
    running.delete("grandchild-1");
    worker.fire("agent_start", {});
    worker.fire("turn_start", { turnIndex: 1 });
    await pollWindow();
    assert.equal(worker.ctx.shutdowns, 0, "the result turn owns the session; the guard stays cancelled");
    worker.settle(finalTurn);
    await pollWindow();
    assert.equal(worker.ctx.shutdowns, 1);
  });

  it("operator input during the deferral disarms: the guard never exits", async () => {
    const running = subagentsTest.runningSubagents as Map<string, any>;
    running.set("grandchild-1", outstandingChild());
    const worker = bootWorker();
    worker.fire("agent_start", {});
    worker.settle(yieldTurn);
    worker.fire("input", { type: "input", text: "let me take over" });
    running.delete("grandchild-1");
    await pollWindow();
    assert.equal(worker.ctx.shutdowns, 0);
  });

  it("a non-auto-exit (interactive) session is never closed by the deferral path", async () => {
    const running = subagentsTest.runningSubagents as Map<string, any>;
    running.set("grandchild-1", outstandingChild());
    const interactive = bootWorker({ autoExit: false });
    interactive.fire("agent_start", {});
    interactive.settle(yieldTurn);
    running.delete("grandchild-1");
    await pollWindow();
    assert.equal(interactive.ctx.shutdowns, 0);
  });
});
