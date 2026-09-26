import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import subagentsExtension, { __test__ as subagentsTest } from "../pi-extension/subagents/index.ts";
import { __herdrTest__ } from "../pi-extension/subagents/herdr.ts";

// TASK-460: when a detached spawn/resume watcher rejects, the error-path
// subagent_result named no session, so Nova's watcher retained the completion
// with childSessionFile undefined and replay retired it as NO_MATCHING_DELEGATION
// while its delegation was still open. Drives the REAL subagent tools (fake
// herdr, fake pi) and feeds the captured message into the REAL live
// nova-notify-watch.ts extension.
//
// Run: timeout 60 node --test --test-name-pattern='<selector>' test/task460-error-path-identity.test.ts
// Selectors: "spawn-error", "resume-error", "unmatched", "success-identity"

const EXT = join(homedir(), ".pi", "agent", "extensions", "nova-notify-watch.ts");
const NO_MATCH = "completion lacks a matching child session/run and original task identity";
const ENV_NAMES = [
  "HERDR_ENV", "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID", "HERDR_LOG", "PATH",
  "PI_CODING_AGENT_DIR", "PI_SUBAGENT_ID", "PI_SUBAGENT_AGENT", "PI_SUBAGENT_SHELL_READY_DELAY_MS",
  "PI_SESSION_FILE", "SULA_DESKTOP_AGENT",
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

/** Fake herdr: panes exist; `pane run` writes the child session + done sidecar when `done`. */
function fakeHerdr(root: string, done: boolean): void {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const command = join(bin, "herdr");
  writeFileSync(command, `#!/usr/bin/env python3
import json, os, re, shlex, sys
args = sys.argv[1:]
if args[:2] == ["pane", "list"]:
    print(json.dumps({"result": {"type": "pane_list", "panes": []}}))
elif args[:2] == ["pane", "current"]:
    print(json.dumps({"result": {"pane": {"pane_id": "parent-pane", "tab_id": "parent-tab", "workspace_id": "parent-workspace"}}}))
elif args[:2] == ["tab", "create"]:
    print(json.dumps({"result": {"root_pane": {"pane_id": "new-pane-" + str(os.getpid())}}}))
elif args[:2] == ["pane", "get"]:
    print(json.dumps({"result": {"pane": {"pane_id": args[2], "agent_status": "working"}}}))
elif args[:2] == ["pane", "run"] and ${done ? "True" : "False"}:
    text = open(shlex.split(args[3])[1]).read()
    m = re.search(r"PI_SUBAGENT_SESSION='([^']+)'", text)
    if m:
        s = m.group(1)
        os.makedirs(os.path.dirname(s), exist_ok=True)
        with open(s, "a") as f:
            f.write(json.dumps({"type": "message", "message": {"role": "assistant", "content": [{"type": "text", "text": "done"}]}}) + "\\n")
        with open(s + ".exit", "w") as f:
            json.dump({"type": "done"}, f)
`, "utf8");
  chmodSync(command, 0o755);
  process.env.PATH = `${bin}:${originalEnv.PATH ?? ""}`;
}

type Captured = { customType: string; content: string; details: Record<string, any> };

/**
 * Launch through the real `subagent` / `subagent_resume` tool. When `failWatcher`,
 * the UI starts throwing inside the watcher after launch, so the detached watcher's promise chain
 * rejects (the TASK-460 trigger) and the `.catch` error completion is sent.
 */
async function launch(kind: "spawn" | "resume", failWatcher: boolean, task: string): Promise<{ root: string; message: Captured; childSession: string }> {
  const root = mkdtempSync(join(tmpdir(), "task460-"));
  roots.push(root);
  const agentDir = join(root, "agent");
  mkdirSync(join(agentDir, "agents"), { recursive: true });
  writeFileSync(join(agentDir, "agents", "task460worker.md"), "---\nname: task460worker\n---\nYou are a test worker.\n", "utf8");
  const parent = join(root, "parent.jsonl");
  writeFileSync(parent, JSON.stringify({ type: "session", version: 3, id: "parent-id", cwd: root }) + "\n", "utf8");
  fakeHerdr(root, !failWatcher);
  Object.assign(process.env, {
    HERDR_ENV: "1", HERDR_PANE_ID: "parent-pane", HERDR_TAB_ID: "parent-tab", HERDR_WORKSPACE_ID: "parent-workspace",
    PI_CODING_AGENT_DIR: agentDir, PI_SUBAGENT_SHELL_READY_DELAY_MS: "0",
  });
  delete process.env.PI_SUBAGENT_ID;
  delete process.env.PI_SUBAGENT_AGENT;
  __herdrTest__.clearCommandAvailability();

  const handlers = new Map<string, Function>();
  const tools: any[] = [];
  const sent: Captured[] = [];
  let uiBroken = false;
  const api = {
    on(event: string, handler: Function) { handlers.set(event, handler); },
    registerTool(tool: any) { tools.push(tool); },
    registerCommand() {}, registerMessageRenderer() {}, registerShortcut() {},
    getAllTools() { return []; },
    getThinkingLevel() { return "medium"; },
    sendUserMessage() {}, appendEntry() {},
    sendMessage(message: Captured) { sent.push(message); },
  } as any;
  const ctx = {
    cwd: root, hasUI: true, mode: "tui", isProjectTrusted: () => true,
    model: { provider: "fake", id: "parent" },
    modelRegistry: { find: () => ({ provider: "fake", id: "parent", reasoning: true }), getAvailable: () => [], hasConfiguredAuth: () => true },
    sessionManager: { getSessionFile: () => parent, getSessionId: () => "parent-id", getSessionDir: () => root },
    ui: {
      notify() {},
      // Only the detached watcher's frames fail; the widget refresh timer stays healthy.
      setWidget() { if (uiBroken && new Error().stack!.includes("watchSubagent")) throw new Error("task460 injected watcher failure"); },
      setStatus() {},
    },
  } as any;
  subagentsExtension(api);
  handlers.get("session_start")?.({}, ctx);
  let childSession = "";
  try {
    if (kind === "spawn") {
      const tool = tools.find((candidate) => candidate.name === "subagent");
      const result = await tool.execute("task460", { name: "task460worker", agent: "task460worker", task, interactive: false }, undefined, undefined, ctx);
      assert.match(result.content[0].text, /launched and is now running/);
      const scriptsDir = join(root, "artifacts", "parent-id", "subagent-scripts");
      const script = readFileSync(join(scriptsDir, readdirSync(scriptsDir)[0]), "utf8");
      childSession = /PI_SUBAGENT_SESSION='([^']+)'/.exec(script)![1];
    } else {
      childSession = join(root, "child-resume.jsonl");
      writeFileSync(childSession, JSON.stringify({ type: "session", version: 3, id: "child-id", cwd: root }) + "\n", "utf8");
      const tool = tools.find((candidate) => candidate.name === "subagent_resume");
      const result = await tool.execute("task460", { sessionPath: childSession, name: "task460resume", message: task }, undefined, undefined, ctx);
      assert.match(result.content[0].text, /resumed/);
    }
    uiBroken = failWatcher;
    const deadline = Date.now() + 8_000;
    while (!sent.some((m) => m.customType === "subagent_result") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } finally {
    uiBroken = false;
    handlers.get("session_shutdown")?.({ reason: "exit" }, ctx);
  }
  const message = sent.find((m) => m.customType === "subagent_result");
  assert.ok(message, "a subagent_result completion was sent");
  console.log(`   [${kind}${failWatcher ? "-error" : ""}] details=${JSON.stringify({ ...message!.details, runtimePlan: undefined })}`);
  return { root, message: message!, childSession };
}

/** Feed the captured completion into the REAL live Nova watcher, then replay it on a fresh session_start. */
async function throughNova(root: string, message: Captured, delegation: { id: string; sessionPath: string }) {
  process.env.SULA_DESKTOP_AGENT = "Nova";
  delete process.env.PI_SESSION_FILE;
  const watch = await import(EXT);
  const project = join(root, "project");
  mkdirSync(project);
  if (!existsSync(delegation.sessionPath)) writeFileSync(delegation.sessionPath, "{}\n");
  const statePath = join(project, ".nova-state.json");
  writeFileSync(statePath, JSON.stringify({
    batch_id: "B-460", task_ids: [], statuses: {}, open_delegations: [delegation.id], notes: [], ts: new Date().toISOString(),
    run_id: "run-460", run_generation: 1,
    delegation_evidence: { [delegation.id]: { status: "running", sessionPath: delegation.sessionPath } },
  }));
  const sends: any[] = [];
  const start = async (event?: unknown) => {
    const handlers: Record<string, Function> = {};
    watch.default({ on: (name: string, h: Function) => { handlers[name] = h; }, sendMessage: (m: any) => { sends.push(m); } });
    handlers.session_start({}, { cwd: project, sessionManager: { getSessionFile: () => undefined, getSessionId: () => "nova-460" } });
    await new Promise((resolve) => setTimeout(resolve, 300)); // deferred replay
    if (event) handlers.message_end(event);
    handlers.session_shutdown?.();
  };
  await start({ message: { role: "custom", ...message } }); // live ingestion (message_end)
  const dir = join(project, ".nova-completions");
  const envelopeAfterLive = JSON.parse(readFileSync(join(dir, readdirSync(dir).find((n) => n.endsWith(".json"))!), "utf8"));
  await start(); // replacement session: replay the retained envelope
  // Track the live-retained envelope by id: an identity-less replay re-retains under a fresh random id.
  const envelopes = readdirSync(dir).filter((n) => n.endsWith(".json")).map((n) => JSON.parse(readFileSync(join(dir, n), "utf8")));
  const envelope = envelopes.find((e) => e.completionId === envelopeAfterLive.completionId);
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  const settled = sends.filter((s) => s.customType === "nova-delegation-settled");
  console.log(`   [nova] live.childSessionFile=${envelopeAfterLive.childSessionFile} status=${envelope.status} ` +
    `delivery=${envelope.delivery}${envelope.retiredReason ? ` retiredReason="${envelope.retiredReason}"` : ""} ` +
    `open=${JSON.stringify(state.open_delegations)} envelopes=${envelopes.length} sends=${JSON.stringify(sends.map((s) => `${s.customType}:${s.details?.outcome ?? ""}`))}`);
  return { envelopeAfterLive, envelope, state, settled, sends };
}

describe("TASK-460 error-path subagent_result carries session identity", { skip: !existsSync(EXT) && "live nova-notify-watch.ts not installed" }, () => {
  it("spawn-error: a rejected spawn watcher's failure settles its open delegation instead of being retired", async () => {
    const { root, message, childSession } = await launch("spawn", true, "Task name: TASK-460 — do the thing\n\nYou are the lane.");
    assert.equal(message.details.error, "task460 injected watcher failure", "the .catch error path produced this completion");
    const nova = await throughNova(root, message, { id: "deep:TASK-460", sessionPath: childSession });
    assert.equal(message.details.sessionFile, childSession, "error completion names the child session file");
    assert.equal(nova.envelopeAfterLive.childSessionFile, childSession, "retained with the child session identity");
    assert.equal(nova.settled.length, 1, "delivered exactly one settle wake");
    assert.equal(nova.settled[0].details.outcome, "matched");
    assert.equal(nova.state.delegation_statuses["deep:TASK-460"], "failed");
    assert.notEqual(nova.envelope.retiredReason, NO_MATCH, "never retired as NO_MATCHING_DELEGATION");
  });

  it("resume-error: a rejected resume watcher's failure is held for its open delegation, never retired", async () => {
    const { root, message, childSession } = await launch("resume", true, "Continue: address the review findings.");
    assert.equal(message.details.error, "task460 injected watcher failure", "the .catch error path produced this completion");
    const nova = await throughNova(root, message, { id: "general:TASK-901-resume", sessionPath: childSession });
    assert.equal(message.details.sessionFile, childSession, "error completion names the resumed session file");
    assert.equal(nova.envelopeAfterLive.childSessionFile, childSession, "retained with the child session identity");
    assert.equal(nova.envelope.delivery, "pending", "kept pending while the delegation is open");
    assert.ok(!nova.envelope.retiredReason, "not retired");
    assert.deepEqual(nova.state.open_delegations, ["general:TASK-901-resume"]);
    assert.equal(nova.sends.length, 0);
  });

  it("unmatched: an error completion for a session no open delegation holds is still retired with zero sends", async () => {
    const { root, message } = await launch("spawn", true, "Task name: TASK-461 — other work");
    const nova = await throughNova(root, message, { id: "engineer:TASK-600", sessionPath: join(root, "unrelated.jsonl") });
    assert.equal(nova.envelope.delivery, "retired");
    assert.equal(nova.envelope.retiredReason, NO_MATCH);
    assert.deepEqual(nova.state.open_delegations, ["engineer:TASK-600"]);
    assert.equal(nova.sends.length, 0);
  });

  it("success-identity: the success-path completion keeps its session identity and settles", async () => {
    const { root, message, childSession } = await launch("spawn", false, "Task name: TASK-460 — do the thing\n\nYou are the lane.");
    assert.equal(message.details.error, undefined);
    assert.equal(message.details.exitCode, 0);
    assert.equal(message.details.sessionFile, childSession);
    assert.equal(message.details.agent, "task460worker");
    const nova = await throughNova(root, message, { id: "deep:TASK-460", sessionPath: childSession });
    assert.equal(nova.settled.length, 1);
    assert.equal(nova.state.delegation_statuses["deep:TASK-460"], "completed");
  });
});
