import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import subagentsExtension, { __test__ as subagentsTest } from "../pi-extension/subagents/index.ts";
import subagentDoneExtension from "../pi-extension/subagents/subagent-done.ts";
import { __herdrTest__ } from "../pi-extension/subagents/herdr.ts";
import { createLifecycle } from "../pi-extension/subagents/lifecycle.ts";

// TASK-458: a lane whose Backlog task is already terminal must not be resumed
// into re-running its gate, and a deliberate interrupt must reach any session
// with its issuer instead of a bare exit 129. Recorded shape 2026-09-26T06:40Z:
// one Nova interrupted its echo lane (TASK-451 verify); the pane close left a
// bare "exited before completing (exit code 129)" sidecar; a second Nova in the
// same process got the interrupted result, read the sidecar as a crash, and
// subagent_resume re-ran the verification of the then-Done TASK-451.
// Drives the REAL subagent_resume tool, interrupt path and child crash hook.
//
// Run: timeout 60 node --test --test-name-pattern='<selector>' test/task458-terminal-task-resume.test.ts
// Selectors: "resume-terminal" (AC1 RED), "terminal-refusal" (AC2), "open-task" (AC3),
//            "issuer" (AC4)

const ENV_NAMES = [
  "HERDR_ENV", "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID", "PATH", "PI_CODING_AGENT_DIR",
  "PI_SUBAGENT_ID", "PI_SUBAGENT_AGENT", "PI_SUBAGENT_SHELL_READY_DELAY_MS", "PI_SUBAGENT_AUTO_EXIT",
  "PI_SUBAGENT_SESSION", "SULA_DESKTOP_AGENT",
] as const;
const originalEnv = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
const roots: string[] = [];

afterEach(() => {
  for (const name of ENV_NAMES) {
    const value = originalEnv[name];
    if (value == null) delete process.env[name];
    else process.env[name] = value;
  }
  subagentsTest.runningSubagents.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const BRIEF = "Task name: TASK-451 — independent verification of the rootless diagnoseNovaState cause fix\n\nYou are the gate.";

/** A project with a Backlog board, a child session whose spawn brief names TASK-451, and a fake herdr. */
function project(status: string) {
  const root = mkdtempSync(join(tmpdir(), "task458-"));
  roots.push(root);
  mkdirSync(join(root, "backlog", "tasks"), { recursive: true });
  writeFileSync(join(root, "backlog", "tasks", "task-451 - Rootless-diagnoseNovaState.md"),
    `---\nid: TASK-451\ntitle: Rootless diagnoseNovaState\nstatus: ${status}\n---\n`, "utf8");
  const child = join(root, "child.jsonl");
  writeFileSync(child, JSON.stringify({ type: "session", version: 3, id: "child-id", cwd: root }) + "\n", "utf8");
  writeFileSync(`${child}.spawn.json`, JSON.stringify({ name: "echo", agent: "echo", task: BRIEF, childSessionFile: child }), "utf8");
  const bin = join(root, "bin");
  mkdirSync(bin);
  const runs = join(root, "pane-runs.log");
  writeFileSync(join(bin, "herdr"), `#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
if args[:2] == ["pane", "list"]:
    print(json.dumps({"result": {"type": "pane_list", "panes": []}}))
elif args[:2] == ["pane", "current"]:
    print(json.dumps({"result": {"pane": {"pane_id": "parent-pane", "tab_id": "parent-tab", "workspace_id": "parent-workspace"}}}))
elif args[:2] == ["tab", "create"]:
    print(json.dumps({"result": {"root_pane": {"pane_id": "new-pane-" + str(os.getpid())}}}))
elif args[:2] == ["pane", "get"]:
    print(json.dumps({"result": {"pane": {"pane_id": args[2], "agent_status": "working"}}}))
elif args[:2] == ["pane", "run"]:
    open(${JSON.stringify(runs)}, "a").write(" ".join(args) + "\\n")
`, "utf8");
  chmodSync(join(bin, "herdr"), 0o755);
  mkdirSync(join(root, "agent", "agents"), { recursive: true });
  Object.assign(process.env, {
    PATH: `${bin}:${originalEnv.PATH ?? ""}`, HERDR_ENV: "1", HERDR_PANE_ID: "parent-pane", HERDR_TAB_ID: "parent-tab",
    HERDR_WORKSPACE_ID: "parent-workspace", PI_CODING_AGENT_DIR: join(root, "agent"), PI_SUBAGENT_SHELL_READY_DELAY_MS: "0",
  });
  delete process.env.PI_SUBAGENT_ID;
  delete process.env.PI_SUBAGENT_AGENT;
  __herdrTest__.clearCommandAvailability();
  const paneRuns = () => (existsSync(runs) ? readFileSync(runs, "utf8").trim().split("\n").filter(Boolean).length : 0);
  return { root, child, paneRuns };
}

/** Call the REAL subagent_resume tool exactly as a Nova turn (or the restore path) does. */
async function resume(root: string, sessionPath: string, extra: Record<string, unknown> = {}) {
  const handlers = new Map<string, Function>();
  const tools: any[] = [];
  const api = {
    on(event: string, handler: Function) { handlers.set(event, handler); },
    registerTool(tool: any) { tools.push(tool); },
    registerCommand() {}, registerMessageRenderer() {}, registerShortcut() {},
    getAllTools() { return []; }, getThinkingLevel() { return "medium"; },
    sendUserMessage() {}, appendEntry() {}, sendMessage() {},
  } as any;
  const parent = join(root, "parent.jsonl");
  writeFileSync(parent, JSON.stringify({ type: "session", version: 3, id: "parent-id", cwd: root }) + "\n", "utf8");
  const ctx = {
    cwd: root, hasUI: true, mode: "tui", isProjectTrusted: () => true,
    model: { provider: "fake", id: "parent" },
    modelRegistry: { find: () => ({ provider: "fake", id: "parent", reasoning: true }), getAvailable: () => [], hasConfiguredAuth: () => true },
    sessionManager: { getSessionFile: () => parent, getSessionId: () => "parent-id", getSessionDir: () => root },
    ui: { notify() {}, setWidget() {}, setStatus() {} },
  } as any;
  subagentsExtension(api);
  handlers.get("session_start")?.({}, ctx);
  try {
    const tool = tools.find((candidate) => candidate.name === "subagent_resume");
    return await tool.execute("task458", { sessionPath, name: "Resume echo", message: "Re-orient and finish.", ...extra }, undefined, undefined, ctx);
  } finally {
    handlers.get("session_shutdown")?.({ reason: "exit" }, ctx);
  }
}

function running(root: string, child: string, overrides: Record<string, unknown> = {}) {
  return {
    id: "8e332cdf", name: "echo", task: BRIEF, agent: "echo", surface: "pane-1", startTime: Date.now() - 50_000,
    sessionFile: child, interactive: false, abortController: { abort() {} },
    lifecycle: createLifecycle(Date.now()),
    ...overrides,
  } as any;
}

describe("TASK-458 terminal-task resume guard", () => {
  it("resume-terminal: resuming a lane whose Backlog task is Done launches no child", async () => {
    const { root, child, paneRuns } = project("Done");
    const result = await resume(root, child);
    console.log(`   [resume-terminal] status=${result.details?.status} paneRuns=${paneRuns()} text=${JSON.stringify(result.content[0].text.slice(0, 160))}`);
    assert.notEqual(result.details?.status, "started", "a Done task's lane must not be resumed");
    assert.equal(paneRuns(), 0, "no pi child was launched for the Done task");
  });

  it("terminal-refusal: the refusal names the task id and its terminal state; the interrupt result does not invite a resume", async () => {
    const { root, child, paneRuns } = project("Done");
    const result = await resume(root, child);
    assert.equal(result.details?.status, "refused");
    assert.equal(result.details?.error, "terminal task");
    assert.equal(result.details?.taskId, "TASK-451");
    assert.equal(result.details?.taskStatus, "Done");
    assert.match(result.content[0].text, /TASK-451 is already terminal \(status: Done\)/);
    assert.equal(paneRuns(), 0);
    console.log(`   [terminal-refusal] ${JSON.stringify(result.content[0].text.slice(0, 200))}`);

    // The interrupted result for the same lane names the terminal task instead of "can be resumed".
    const run = running(root, child, { interrupted: { errorMessage: "x", interruptedAt: Date.now(), issuer: "Nova session S2" } });
    const interrupted = subagentsTest.buildInterruptedResult(run, Date.now());
    const text = subagentsTest.resolveResultPresentation(interrupted, "echo");
    console.log(`   [terminal-refusal] interrupted=${JSON.stringify(text.slice(0, 260))}`);
    assert.match(text, /TASK-451 is already terminal \(status: Done\)/);
    assert.doesNotMatch(text, /can be resumed with subagent_resume/);

    // Explicit post-Done opt-in (e.g. an interrupted save-work lane) still resumes.
    const optIn = await resume(root, child, { allowTerminalTask: true });
    assert.equal(optIn.details?.status, "started");
    assert.equal(paneRuns(), 1);
  });

  it("open-task: a lane whose task is still open resumes exactly as before", async () => {
    const { root, child, paneRuns } = project("In Progress");
    const result = await resume(root, child);
    console.log(`   [open-task] status=${result.details?.status} paneRuns=${paneRuns()}`);
    assert.equal(result.details?.status, "started");
    assert.equal(paneRuns(), 1);
    const run = running(root, child, { interrupted: { errorMessage: "x", interruptedAt: Date.now() } });
    const text = subagentsTest.resolveResultPresentation(subagentsTest.buildInterruptedResult(run, Date.now()), "echo");
    assert.match(text, /can be resumed with subagent_resume/);
    // A brief with no Backlog task identity is never refused.
    writeFileSync(`${child}.spawn.json`, JSON.stringify({ task: "Coverage audit, no task id" }), "utf8");
    const plain = await resume(root, child);
    assert.equal(plain.details?.status, "started");
  });

  it("issuer: a deliberate interrupt names its issuer in the result and in the child's exit sidecar", async () => {
    const { root, child } = project("In Progress");
    process.env.SULA_DESKTOP_AGENT = "Nova";
    const runningMap = subagentsTest.runningSubagents as Map<string, any>;
    const run = running(root, child);
    runningMap.set(run.id, run);
    let closed = 0;
    subagentsTest.handleSubagentInterrupt({ id: run.id }, () => {}, {
      graceMs: 0, closePane: () => { closed += 1; }, abortWatcher: () => {}, issuer: "Nova session 01a0dc61-6cca",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(closed, 1);
    const text = subagentsTest.resolveResultPresentation(subagentsTest.buildInterruptedResult(run, Date.now()), "echo");
    console.log(`   [issuer] result=${JSON.stringify(text.slice(0, 240))}`);
    assert.match(text, /was interrupted after .* by Nova session 01a0dc61-6cca/);
    assert.match(text, /deliberate subagent_interrupt, not a crash/);

    // The pane close ends the child with SIGHUP (exit 129): its crash hook must say so.
    const priorExit = process.listeners("exit");
    process.env.PI_SUBAGENT_AUTO_EXIT = "1";
    process.env.PI_SUBAGENT_SESSION = child;
    try {
      let hooks: { registerCrashHooks: (argv?: readonly string[]) => void } | undefined;
      subagentDoneExtension({ on() {}, registerTool() {}, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {},
        sendMessage() {}, sendUserMessage() {}, appendEntry() {}, getAllTools: () => [], setActiveTools() {}, getActiveTools: () => [] } as any,
        { onReady: (h: any) => { hooks = h; } });
      hooks!.registerCrashHooks(["node", "pi", "--session", child]);
      const exitHandler = process.listeners("exit").find((h) => !priorExit.includes(h)) as (code: number) => void;
      exitHandler(129);
    } finally {
      for (const handler of process.listeners("exit")) if (!priorExit.includes(handler)) process.off("exit", handler as () => void);
    }
    const sidecar = JSON.parse(readFileSync(`${child}.exit`, "utf8"));
    console.log(`   [issuer] sidecar=${JSON.stringify(sidecar.message)}`);
    assert.equal(sidecar.exitCode, 129);
    assert.equal(sidecar.interruptedBy, "Nova session 01a0dc61-6cca");
    assert.match(sidecar.message, /deliberate interrupt from Nova session 01a0dc61-6cca/);
    assert.doesNotMatch(sidecar.message, /exited before completing/);
  });
});
