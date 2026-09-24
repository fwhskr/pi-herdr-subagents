import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import subagentDoneExtension from "../pi-extension/subagents/subagent-done.ts";
import { __test__ as subagentsTest } from "../pi-extension/subagents/index.ts";
import { createLifecycle } from "../pi-extension/subagents/lifecycle.ts";

// TASK-236 AC4 / Sade docs/agent-identity-lla.md §5A row "Pending-child yield
// (stays active)": a one-shot worker that yields while a delegated child it
// spawned is still outstanding stays active until that child settles; the
// yield alone never settles it terminally. The worker's outstanding children
// are the in-process runtime registry the `subagent` tool writes on spawn and
// the completion watcher clears once the child settles.
//
// RED EVIDENCE at a7ff4f5: auto-exit consults only the stop reason, never the
// runtime registry (production fix tracked as TASK-395). Not registered in
// scripts.test while red.

const originalEnv = {
  autoExit: process.env.PI_SUBAGENT_AUTO_EXIT,
  session: process.env.PI_SUBAGENT_SESSION,
  subagentId: process.env.PI_SUBAGENT_ID,
  activityFile: process.env.PI_SUBAGENT_ACTIVITY_FILE,
};
const tempDirs = new Set<string>();

function restoreEnv(name: string, value: string | undefined) {
  if (value == null) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  restoreEnv("PI_SUBAGENT_AUTO_EXIT", originalEnv.autoExit);
  restoreEnv("PI_SUBAGENT_SESSION", originalEnv.session);
  restoreEnv("PI_SUBAGENT_ID", originalEnv.subagentId);
  restoreEnv("PI_SUBAGENT_ACTIVITY_FILE", originalEnv.activityFile);
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
  (subagentsTest.runningSubagents as Map<string, any>).clear();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.add(dir);
  return dir;
}

/** Boot the real child-side extension as an armed one-shot worker. */
function bootWorker() {
  delete process.env.PI_SUBAGENT_ID;
  delete process.env.PI_SUBAGENT_ACTIVITY_FILE;
  process.env.PI_SUBAGENT_AUTO_EXIT = "1";
  const sessionFile = join(tempDir("task236-worker-"), "worker.jsonl");
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
    cwd: tempDir("task236-cwd-"),
    sessionManager: { getEntries: () => [] },
    ui: { notify() {}, setWidget() {} },
    shutdown() { ctx.shutdowns += 1; },
  };
  const fire = (event: string, payload: any = {}) => {
    for (const handler of handlers.get(event) ?? []) handler(payload, ctx);
  };
  return {
    ctx,
    sessionFile,
    fire,
    settle(messages: any[]) {
      fire("agent_end", { messages });
      fire("agent_settled", { type: "agent_settled" });
    },
    release() {
      for (const h of process.listeners("exit")) {
        if (!priorExit.includes(h)) process.off("exit", h as () => void);
      }
      for (const h of process.listeners("uncaughtException")) {
        if (!priorUncaught.includes(h)) process.off("uncaughtException", h as (e: Error) => void);
      }
    },
  };
}

/** The registry row the `subagent` tool writes for a launched, unsettled child. */
function outstandingChild() {
  return {
    id: "grandchild-1",
    name: "Grandchild",
    task: "bounded delegated task",
    surface: "pane-grandchild",
    startTime: Date.now(),
    sessionFile: join(tempDir("task236-grandchild-"), "grandchild.jsonl"),
    cli: "pi",
    interactive: false,
    lifecycle: createLifecycle(Date.now()),
    abortController: new AbortController(),
  };
}

const spawnAckTurn = [
  {
    role: "assistant",
    stopReason: "toolUse",
    content: [{ type: "toolCall", id: "spawn-1", name: "subagent", arguments: { name: "Grandchild" } }],
  },
  {
    role: "toolResult",
    toolCallId: "spawn-1",
    isError: false,
    content: [{ type: "text", text: 'Sub-agent "Grandchild" launched and is now running in the background.' }],
  },
];
const yieldTurn = [
  {
    role: "assistant",
    stopReason: "stop",
    content: [{ type: "text", text: "Delegated the slice; waiting for the child result." }],
  },
];
const finalTurn = [
  {
    role: "assistant",
    stopReason: "stop",
    content: [{ type: "text", text: "Final report: child result integrated." }],
  },
];

describe("TASK-236 AC4 pending-child yield (LLA §5A)", () => {
  it("stays active while a delegated child is outstanding, then settles once after the child settles", () => {
    const running = subagentsTest.runningSubagents as Map<string, any>;
    const worker = bootWorker();
    try {
      worker.fire("agent_start", {});
      worker.settle(spawnAckTurn);
      running.set("grandchild-1", outstandingChild());

      // The worker yields with a terminal stop while its child is outstanding.
      worker.settle(yieldTurn);
      assert.equal(worker.ctx.shutdowns, 0, "a yield with an outstanding child must not shut the worker down");
      assert.equal(existsSync(`${worker.sessionFile}.exit`), false, "the yield must not publish a terminal sidecar");

      // The child settles: the watcher removes it and steers its result into a new worker turn.
      running.delete("grandchild-1");
      worker.settle(finalTurn);
      assert.equal(worker.ctx.shutdowns, 1, "the worker settles once after the child settled");
      assert.equal(existsSync(`${worker.sessionFile}.exit`), true, "terminal sidecar published after the child settled");
    } finally {
      worker.release();
    }
  });

  it("control: with no outstanding child the same yield turn auto-exits once", () => {
    const worker = bootWorker();
    try {
      worker.fire("agent_start", {});
      worker.settle(yieldTurn);
      assert.equal(worker.ctx.shutdowns, 1);
      assert.equal(existsSync(`${worker.sessionFile}.exit`), true);
    } finally {
      worker.release();
    }
  });
});
