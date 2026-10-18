// TASK-321: delegated forced-exit classification must follow the lifecycle Pi
// actually emits (reproduced on the pinned core by TASK-323):
//
//  - quit / SIGTERM / SIGHUP (runtime dispose) while a tool runs:
//      tool_execution_start, session_shutdown(quit), turn_end,
//      agent_settled(aborted=false) — no tool_execution_end, no agent_end, and
//      the settle's ctx is already stale. The dispose already stopped the tool;
//      this stale settle must not be classified "missing stopReason" or exit.
//  - operator / parent abort (session.abort) while a tool runs:
//      tool_execution_start, tool_execution_end, turn_end, turn_start,
//      turn_end, agent_end(stopReason=error "This operation was aborted"),
//      agent_settled(aborted=true). Pi's abort flag wins: 130, never retried.
import { after, afterEach, it, mock } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import done from "../pi-extension/subagents/subagent-done.ts";

const scratchRoot = "/home/kris/.pi/agent/var/TASK-321/fixtures";
mkdirSync(scratchRoot, { recursive: true });
const original = { ...process.env };
const dirs: string[] = [];
const releases: Array<() => void> = [];
afterEach(() => {
  mock.timers.reset();
  for (const release of releases.splice(0)) release();
  for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
  Object.assign(process.env, original);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
after(() => rmSync(scratchRoot, { recursive: true, force: true }));

const ABORT_ERROR = "This operation was aborted";

function boot(opts: { runId?: string } = {}) {
  const priorExit = process.listeners("exit");
  const priorUncaught = process.listeners("uncaughtException");
  releases.push(() => {
    for (const h of process.listeners("exit")) if (!priorExit.includes(h)) process.off("exit", h as () => void);
    for (const h of process.listeners("uncaughtException")) {
      if (!priorUncaught.includes(h)) process.off("uncaughtException", h as (e: Error) => void);
    }
  });
  const dir = mkdtempSync(join(scratchRoot, "run-"));
  dirs.push(dir);
  const file = join(dir, "child.jsonl");
  writeFileSync(file, "");
  process.env.PI_SUBAGENT_AUTO_EXIT = "1";
  if (opts.runId === undefined) process.env.PI_SUBAGENT_ID = "fixture-run";
  else if (opts.runId) process.env.PI_SUBAGENT_ID = opts.runId;
  else delete process.env.PI_SUBAGENT_ID;
  process.env.PI_SUBAGENT_SESSION = file;
  delete process.env.PI_SUBAGENT_ACTIVITY_FILE;
  delete process.env.PI_SUBAGENT_AUTO_EXIT_REARM;
  delete process.env.PI_SUBAGENT_RESUME_INPUT;
  const events = new Map<string, Function[]>();
  const sent: string[] = [];
  const notes: Array<{ message: string; type?: string }> = [];
  let shutdowns = 0;
  let stale = false;
  const live = {
    cwd: dir,
    shutdown() { shutdowns++; },
    ui: { notify(message: string, type?: string) { notes.push({ message, type }); }, setWidget() {} },
    sessionManager: { getEntries: () => [], getSessionFile: () => file },
  };
  // Pi invalidates the extension ctx once the session is shut down: any use
  // of it afterwards throws, exactly like the reproduced "ctx-STALE" settle.
  const ctx: any = new Proxy(live, {
    get(target, key) {
      if (stale) throw new Error("This extension ctx is stale after session replacement or reload.");
      return (target as any)[key];
    },
  });
  let hooks: { registerCrashHooks: (argv?: readonly string[]) => void } | undefined;
  done({
    on: (n: string, h: Function) => events.set(n, [...(events.get(n) ?? []), h]),
    registerTool() {}, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {},
    getAllTools: () => [], sendUserMessage: (m: string) => sent.push(m), sendMessage() {},
  } as any, { onReady: (h: any) => { hooks = h; } });
  const fire = (n: string, e: any = {}) => { for (const h of events.get(n) ?? []) h(e, ctx); };
  fire("agent_start");
  fire("turn_start", { turnIndex: 0 });
  return {
    file, fire, sent, notes,
    shutdowns: () => shutdowns,
    markStale() { stale = true; },
    /** Arm the real process-exit hook as a `--session` child would, return it. */
    armExitHook(): (code: number) => void {
      const before = process.listeners("exit");
      hooks!.registerCrashHooks(["node", "pi", "--session", file]);
      return process.listeners("exit").find((h) => !before.includes(h)) as (code: number) => void;
    },
    terminal: () => {
      const path = `${file}.terminal.${opts.runId || "fixture-run"}.json`;
      return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
    },
    exitSidecar: () => (existsSync(`${file}.exit`) ? JSON.parse(readFileSync(`${file}.exit`, "utf8")) : null),
    startTool(id: string, name = "verify_run") { fire("tool_execution_start", { toolCallId: id, toolName: name }); },
    endTool(id: string, name = "verify_run") { fire("tool_execution_end", { toolCallId: id, toolName: name }); },
    settle(messages: any[] | undefined, aborted = false) {
      if (messages) fire("agent_end", { messages });
      fire("agent_settled", { type: "agent_settled", aborted });
    },
  };
}

const assistant = (stopReason: string, extra: Record<string, unknown> = {}) =>
  ({ role: "assistant", stopReason, content: [], ...extra });

/** The reproduced runtime-dispose (quit) order with a tool in flight. */
function disposeWhileToolRuns(child: ReturnType<typeof boot>) {
  child.startTool("call-1");
  child.fire("session_shutdown", { type: "session_shutdown", reason: "quit" });
  child.markStale();
  child.fire("turn_end", { turnIndex: 0 });
  child.settle(undefined, false);
}

/** The reproduced session.abort() order with a tool in flight. */
function abortWhileToolRuns(child: ReturnType<typeof boot>) {
  child.startTool("call-2");
  child.endTool("call-2");
  child.fire("turn_end", { turnIndex: 0 });
  child.fire("turn_start", { turnIndex: 1 });
  child.fire("turn_end", { turnIndex: 1 });
  child.settle([assistant("toolUse"), assistant("error", { errorMessage: ABORT_ERROR })], true);
}

it("quit dispose with a tool in flight: the stale post-shutdown settle is not a forced 'missing' exit", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const child = boot();
  disposeWhileToolRuns(child);
  mock.timers.tick(3_600_000);
  assert.equal(child.shutdowns(), 0, "a shut-down session is never re-shut-down from a stale settle");
  assert.equal(child.terminal(), null, "no forced terminal record from a post-shutdown settle");
  assert.equal(child.exitSidecar(), null, "no misclassified missing-stopReason sidecar");
  assert.deepEqual(child.sent, [], "no automatic continuation");
});

it("quit dispose: the process exit records the shutdown reason, not a missing stopReason", () => {
  const child = boot();
  const onExit = child.armExitHook();
  disposeWhileToolRuns(child);
  onExit(0);
  const sidecar = child.exitSidecar();
  assert.equal(sidecar.type, "error");
  assert.equal(sidecar.exitCode, 0);
  assert.match(sidecar.errorMessage, /session shut down \(reason=quit\) before completing/);
  assert.doesNotMatch(sidecar.errorMessage, /stopReason=missing/);
  assert.equal(sidecar.forcedExit, undefined, "not a forced delegated exit");
});

it("quit dispose after a parent interrupt keeps the deliberate-interrupt attribution", () => {
  const child = boot();
  const onExit = child.armExitHook();
  writeFileSync(`${child.file}.interrupt`, JSON.stringify({ issuer: "parent fixture", interruptedAt: "t0" }));
  disposeWhileToolRuns(child);
  onExit(129);
  const sidecar = child.exitSidecar();
  assert.equal(sidecar.interruptedBy, "parent fixture");
  assert.match(sidecar.errorMessage, /deliberate interrupt from parent fixture/);
});

it("abort with a tool in flight: settle aborted=true over stopReason=error is an abort (130)", () => {
  const child = boot();
  abortWhileToolRuns(child);
  assert.equal(child.shutdowns(), 1, "abort closes the delegated run at once");
  const record = child.terminal();
  assert.equal(record.type, "error");
  assert.equal(record.forcedExit, true);
  assert.equal(record.exitCode, 130);
  assert.equal(record.stopReason, "aborted");
  assert.doesNotMatch(record.errorMessage, /without a terminal assistant response/);
  assert.deepEqual(child.sent, [], "an abort is never auto-resumed or retried");
  child.settle(undefined, false);
  assert.equal(child.shutdowns(), 1, "single terminal attempt");
});

it("abort before any assistant message (settle aborted=true, stopReason missing) is 130", () => {
  const child = boot();
  child.settle([], true);
  assert.equal(child.shutdowns(), 1);
  assert.equal(child.terminal().exitCode, 130);
  assert.equal(child.terminal().stopReason, "aborted");
});

it("a time-limit abort with stopReason=error still triggers the wrap-up continuation", () => {
  const child = boot();
  writeFileSync(`${child.file}.wrapup`, "Time limit reached: report now.");
  abortWhileToolRuns(child);
  assert.equal(child.shutdowns(), 0, "wrap-up continuation runs instead of closing");
  assert.deepEqual(child.sent, ["Time limit reached: report now."]);
});

it("non-delegated session: Escape abort with stopReason=error disarms and stays open", () => {
  const child = boot({ runId: "" });
  abortWhileToolRuns(child);
  assert.equal(child.shutdowns(), 0);
  assert.equal(child.exitSidecar(), null);
  assert.ok(child.notes.some((n) => /Auto-exit disabled \(Escape\)/.test(n.message)), "Escape abort recognized");
  child.settle([assistant("stop")]);
  assert.equal(child.shutdowns(), 0, "operator takeover stays sticky");
});

it("normal terminal stop exits immediately with done", () => {
  const child = boot();
  child.startTool("call-4", "bash");
  child.endTool("call-4", "bash");
  child.settle([assistant("stop", { content: [{ type: "text", text: "ok" }] })]);
  assert.equal(child.shutdowns(), 1);
  assert.equal(child.terminal().type, "done");
  assert.equal(child.terminal().exitCode, 0);
});

it("a genuine provider error (not aborted) stays a provider error (exit 1)", () => {
  const child = boot();
  child.settle([assistant("error", { errorMessage: "provider exploded" })]);
  assert.equal(child.shutdowns(), 1);
  assert.equal(child.terminal().exitCode, 1);
  assert.equal(child.terminal().stopReason, "error");
  assert.equal(child.terminal().errorMessage, "provider exploded");
});

it("a live (not shut down, not aborted) settle without a terminal response still force-exits 1", () => {
  const child = boot();
  child.settle([assistant("toolUse")]);
  assert.equal(child.shutdowns(), 1);
  assert.equal(child.terminal().exitCode, 1);
  assert.match(child.terminal().errorMessage, /stopReason=toolUse/);
});
