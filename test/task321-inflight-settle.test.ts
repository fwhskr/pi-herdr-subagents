// TASK-321: a delegated run that settles while a tool call is still in flight
// must not be force-closed before that tool ends (or a bounded deadline), and
// a settle that Pi itself reports as aborted is an abort (130), never a
// generic missing-stopReason failure. Operator aborts stay authoritative.
import { after, afterEach, it } from "node:test";
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
  for (const release of releases.splice(0)) release();
  for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
  Object.assign(process.env, original);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
after(() => rmSync(scratchRoot, { recursive: true, force: true }));

function boot(opts: { runId?: string; graceMs?: number } = {}) {
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
  process.env.PI_SUBAGENT_INFLIGHT_TOOL_GRACE_MS = String(opts.graceMs ?? 5_000);
  delete process.env.PI_SUBAGENT_ACTIVITY_FILE;
  delete process.env.PI_SUBAGENT_AUTO_EXIT_REARM;
  delete process.env.PI_SUBAGENT_RESUME_INPUT;
  const events = new Map<string, Function[]>();
  const sent: string[] = [];
  const notes: Array<{ message: string; type?: string }> = [];
  let shutdowns = 0;
  const ctx: any = {
    cwd: dir,
    shutdown() { shutdowns++; },
    ui: { notify(message: string, type?: string) { notes.push({ message, type }); }, setWidget() {} },
    sessionManager: { getEntries: () => [], getSessionFile: () => file },
  };
  done({
    on: (n: string, h: Function) => events.set(n, [...(events.get(n) ?? []), h]),
    registerTool() {}, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {},
    getAllTools: () => [], sendUserMessage: (m: string) => sent.push(m), sendMessage() {},
  } as any);
  const fire = (n: string, e: any = {}) => { for (const h of events.get(n) ?? []) h(e, ctx); };
  fire("agent_start");
  return {
    file, ctx, fire, sent, notes,
    shutdowns: () => shutdowns,
    terminal: () => {
      const path = `${file}.terminal.${opts.runId || "fixture-run"}.json`;
      return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
    },
    exitSidecar: () => (existsSync(`${file}.exit`) ? JSON.parse(readFileSync(`${file}.exit`, "utf8")) : null),
    startTool(id: string, name = "verify_run") { fire("tool_execution_start", { toolCallId: id, toolName: name }); },
    endTool(id: string, name = "verify_run") { fire("tool_execution_end", { toolCallId: id, toolName: name }); },
    settle(messages: any[], aborted = false) {
      fire("agent_end", { messages });
      fire("agent_settled", { type: "agent_settled", aborted });
    },
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(cond: () => boolean, deadlineMs: number): Promise<boolean> {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    if (cond()) return true;
    await sleep(5);
  }
  return cond();
}

it("missing stopReason with an in-flight tool does not force exit before the tool ends", async () => {
  const child = boot();
  child.startTool("call-1");
  child.settle([]);
  await sleep(30);
  assert.equal(child.shutdowns(), 0, "in-flight tool must not be torn down by the settle");
  assert.equal(child.exitSidecar(), null, "no terminal sidecar before the tool ends");
  child.endTool("call-1");
  assert.ok(await waitFor(() => child.shutdowns() === 1, 2_000), "exits once the tool ended");
  const record = child.terminal();
  assert.equal(record.type, "error");
  assert.equal(record.forcedExit, true);
  assert.equal(record.exitCode, 1);
  assert.match(record.errorMessage, /stopReason=missing/);
  assert.deepEqual(child.sent, [], "no automatic resume or continuation");
});

it("an in-flight tool that never ends is bounded by the grace deadline", async () => {
  const child = boot({ graceMs: 80 });
  child.startTool("hung");
  const startedAt = Date.now();
  child.settle([{ role: "assistant", stopReason: "toolUse", content: [] }]);
  assert.equal(child.shutdowns(), 0);
  assert.ok(await waitFor(() => child.shutdowns() === 1, 3_000), "exit must not wait unbounded");
  assert.ok(Date.now() - startedAt >= 70, "exit waited for the deadline");
  assert.equal(child.terminal().exitCode, 1);
  assert.equal(child.terminal().stopReason, "toolUse");
});

it("a settle reported aborted is an abort (130) and stays authoritative over in-flight tools", () => {
  const child = boot();
  child.startTool("call-2");
  child.settle([], true);
  assert.equal(child.shutdowns(), 1, "operator/parent abort closes immediately");
  const record = child.terminal();
  assert.equal(record.type, "error");
  assert.equal(record.forcedExit, true);
  assert.equal(record.exitCode, 130);
  assert.equal(record.stopReason, "aborted");
  assert.doesNotMatch(record.errorMessage, /without a terminal assistant response/);
  assert.deepEqual(child.sent, [], "abort is never auto-resumed");
  child.endTool("call-2");
  child.fire("agent_settled", { type: "agent_settled", aborted: false });
  assert.equal(child.shutdowns(), 1, "single terminal attempt");
});

it("a settle reported aborted with no tool in flight is also 130, not generic missing", () => {
  const child = boot();
  child.settle([], true);
  assert.equal(child.shutdowns(), 1);
  assert.equal(child.terminal().exitCode, 130);
});

it("a new turn starting during the in-flight wait owns the lifecycle; its settle decides", async () => {
  const child = boot();
  child.startTool("call-3");
  child.settle([]);
  child.fire("agent_start");
  child.fire("turn_start", { turnIndex: 0 });
  child.endTool("call-3");
  await sleep(30);
  assert.equal(child.shutdowns(), 0, "the started turn cancels the pending forced exit");
  child.settle([{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "report" }] }]);
  assert.equal(child.shutdowns(), 1);
  assert.equal(child.terminal().exitCode, 0);
  assert.equal(child.terminal().type, "done");
});

it("normal terminal stop exits immediately and an unrelated finished tool does not delay it", () => {
  const child = boot();
  child.startTool("call-4", "bash");
  child.endTool("call-4", "bash");
  child.settle([{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "ok" }] }]);
  assert.equal(child.shutdowns(), 1);
  assert.equal(child.terminal().exitCode, 0);
});

it("non-delegated session: an aborted settle with missing stopReason disarms and stays open", () => {
  const child = boot({ runId: "" });
  child.settle([], true);
  assert.equal(child.shutdowns(), 0);
  assert.ok(child.notes.some((n) => /Auto-exit disabled \(Escape\)/.test(n.message)), "Escape abort recognized");
  child.settle([{ role: "assistant", stopReason: "stop", content: [] }]);
  assert.equal(child.shutdowns(), 0, "operator takeover stays sticky");
});
