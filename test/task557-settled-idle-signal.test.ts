import { describe, it, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import subagentDoneExtension from "../pi-extension/subagents/subagent-done.ts";
import { __test__ as subagentsTest } from "../pi-extension/subagents/index.ts";
import { readSubagentActivityFile } from "../pi-extension/subagents/activity.ts";
import {
  createLifecycle,
  lifecycleTransition,
  observeActivity,
  observePaneInspection,
  projectLifecycle,
} from "../pi-extension/subagents/lifecycle.ts";

// TASK-557 AC4: a worker (including auto-exit:false profiles) whose turn settles with no
// subagent_done/caller_ping and nothing outstanding is surfaced to the delegator within
// 60 s, not after the 600 s idle-lane window. Controls: a normal auto-exit one-shot still
// delivers and exits; a worker yielding for an outstanding child is not flagged; a plain
// agent_end (non-terminal window) keeps the long bound.
// Run: timeout 120 node --experimental-strip-types --test test/task557-settled-idle-signal.test.ts

const ENV_NAMES = [
  "PI_SUBAGENT_AUTO_EXIT", "PI_SUBAGENT_AUTO_EXIT_REARM", "PI_SUBAGENT_RESUME_INPUT",
  "PI_SUBAGENT_SESSION", "PI_SUBAGENT_ID", "PI_SUBAGENT_ACTIVITY_FILE", "PI_SUBAGENT_PENDING_CHILD_POLL_MS",
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

const CHILD_ID = "child-557";

function bootWorker(autoExit: boolean) {
  for (const name of ENV_NAMES) delete process.env[name];
  if (autoExit) process.env.PI_SUBAGENT_AUTO_EXIT = "1";
  process.env.PI_SUBAGENT_PENDING_CHILD_POLL_MS = "5";
  const dir = tempDir("task557-worker-");
  const sessionFile = join(dir, "worker.jsonl");
  const activityFile = join(dir, "worker.activity.json");
  writeFileSync(sessionFile, "session header\n");
  process.env.PI_SUBAGENT_SESSION = sessionFile;
  process.env.PI_SUBAGENT_ID = CHILD_ID;
  process.env.PI_SUBAGENT_ACTIVITY_FILE = activityFile;

  const priorExit = process.listeners("exit");
  const priorUncaught = process.listeners("uncaughtException");
  const handlers = new Map<string, Function[]>();
  subagentDoneExtension({
    on(event: string, handler: Function) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
    registerTool() {}, registerCommand() {}, registerMessageRenderer() {}, registerShortcut() {},
    sendUserMessage() {}, sendMessage() {}, getAllTools() { return []; },
  } as any);
  const ctx: any = {
    shutdowns: 0,
    cwd: tempDir("task557-cwd-"),
    sessionManager: { getEntries: () => [] },
    ui: { notify() {}, setWidget() {} },
    shutdown() { ctx.shutdowns += 1; },
  };
  const fire = (event: string, payload: any = {}) => { for (const h of handlers.get(event) ?? []) h(payload, ctx); };
  const release = () => {
    fire("session_shutdown", { reason: "test" });
    for (const h of process.listeners("exit")) if (!priorExit.includes(h)) process.off("exit", h as () => void);
    for (const h of process.listeners("uncaughtException")) if (!priorUncaught.includes(h)) process.off("uncaughtException", h as (e: Error) => void);
  };
  releases.push(release);
  return {
    ctx, sessionFile, activityFile, fire,
    activity: () => readSubagentActivityFile(activityFile, CHILD_ID),
    settle(text = "Idle; waiting for Nova.") {
      fire("agent_start", {});
      fire("agent_end", { messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text }] }] });
      fire("agent_settled", { type: "agent_settled" });
    },
  };
}

/** A pane Herdr reports idle after work, as the parent sees it. */
function idlePane(idleAt: number) {
  let lifecycle = createLifecycle(0);
  lifecycle = observePaneInspection(lifecycle, { kind: "present", agentStatus: "working", observedAt: 1_000 }, 1_000);
  return observePaneInspection(lifecycle, { kind: "present", agentStatus: "idle", observedAt: idleAt }, idleAt);
}

describe("TASK-557 AC4 settled-without-close is surfaced within 60 s", () => {
  it("an auto-exit:false worker that settles with no close marks its activity settled; the next turn clears it", () => {
    const worker = bootWorker(false);
    worker.settle();
    const read = worker.activity();
    assert.ok(read.ok, "activity file readable");
    assert.equal(read.activity.phase, "waiting");
    assert.equal(typeof read.activity.settledAt, "number", "settled marker written");
    assert.equal(worker.ctx.shutdowns, 0, "auto-exit:false stays open");
    worker.fire("agent_start", {});
    const next = worker.activity();
    assert.ok(next.ok);
    assert.equal(next.activity.settledAt, undefined, "a new turn clears the marker");
  });

  it("the parent projects a settled lane idle after 30 s, and a plain agent_end window keeps the 600 s bound", () => {
    const worker = bootWorker(false);
    worker.settle();
    const read = worker.activity();
    assert.ok(read.ok);
    const at = read.activity.settledAt!;
    const settled = observeActivity(idlePane(at), read, at);
    assert.equal(projectLifecycle(settled, at + 29_999).kind, "waiting");
    const projection = projectLifecycle(settled, at + 30_000);
    assert.equal(projection.kind, "idle");
    assert.equal(lifecycleTransition("waiting", projection.kind), "idle");

    const { settledAt: _drop, ...unsettledActivity } = read.activity;
    const transient = observeActivity(idlePane(at), { ok: true, activity: unsettledActivity }, at);
    assert.equal(projectLifecycle(transient, at + 59_000).kind, "waiting", "non-terminal agent_end is not flagged early");
  });

  it("control: a worker yielding for an outstanding child is never marked settled", () => {
    (subagentsTest.runningSubagents as Map<string, any>).set("grandchild", {
      id: "grandchild", name: "researcher", task: "t", surface: "p", startTime: Date.now(),
      sessionFile: join(tempDir("task557-gc-"), "gc.jsonl"), cli: "pi", interactive: false,
      lifecycle: createLifecycle(Date.now()), abortController: new AbortController(),
    });
    const worker = bootWorker(false);
    worker.settle("Delegated to researcher; waiting.");
    const read = worker.activity();
    assert.ok(read.ok);
    assert.equal(read.activity.settledAt, undefined);
  });

  it("negative control: a normal auto-exit one-shot still delivers and exits", () => {
    const worker = bootWorker(true);
    worker.settle("Final report.");
    assert.equal(worker.ctx.shutdowns, 1, "one-shot exits");
    assert.ok(existsSync(`${worker.sessionFile}.exit`), "completion sidecar delivered");
    const read = worker.activity();
    assert.ok(read.ok);
    assert.equal(read.activity.phase, "done");
    assert.equal(read.activity.settledAt, undefined);
  });

  it("end to end: the delegator's status loop wakes once within 60 s of the settle", () => {
    const worker = bootWorker(false);
    worker.settle();
    const read = worker.activity();
    assert.ok(read.ok);
    const settledAt = read.activity.settledAt!;
    mock.timers.enable({ apis: ["setInterval", "Date"], now: settledAt });
    const sent: Array<{ message: any; options: any }> = [];
    const running: any = {
      id: CHILD_ID, name: "artist", task: "visible work", surface: "pane-557", startTime: settledAt - 60_000,
      sessionFile: worker.sessionFile, activityFile: worker.activityFile, interactive: false,
      lifecycle: idlePane(settledAt),
    };
    subagentsTest.runningSubagents.set(running.id, running);
    try {
      subagentsTest.startStatusRefresh({ sendMessage: (message: any, options: any) => sent.push({ message, options }) });
      mock.timers.tick(59_000);
      assert.equal(sent.length, 1, "woken within 60 s");
      assert.equal(sent[0].options.triggerTurn, true);
      assert.match(String(sent[0].message.content), /artist .*idle.*no close/);
      mock.timers.tick(600_000);
      assert.equal(sent.length, 1, "one wake per idle episode");
    } finally {
      subagentsTest.runningSubagents.delete(running.id);
      mock.timers.tick(1_000);
      mock.timers.reset();
    }
  });
});
