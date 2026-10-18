import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import subagentsExtension, { __test__ as subagentsTest } from "../pi-extension/subagents/index.ts";
import { __herdrTest__ } from "../pi-extension/subagents/herdr.ts";
import { discoverOrphanedSubagents } from "../pi-extension/subagents/orphan-discovery.ts";

// TASK-313: the caller-supplied `delegation_id` label travels, exactly as given,
// through launch metadata (before the child runs), the started result and every
// completion envelope, and a resume inherits it or refuses a conflicting one.
// Run: timeout 60 node --test test/task313-delegation-label.test.ts

const SCRATCH = "/home/kris/.pi/agent/var";
const ENV_NAMES = [
  "HERDR_ENV", "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID", "PATH",
  "PI_CODING_AGENT_DIR", "PI_SUBAGENT_ID", "PI_SUBAGENT_AGENT", "PI_SUBAGENT_SHELL_READY_DELAY_MS",
] as const;
const originalEnv = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const name of ENV_NAMES) {
    const value = originalEnv[name];
    if (value == null) delete process.env[name];
    else process.env[name] = value;
  }
  subagentsTest.runningSubagents.clear();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** Fake herdr: snapshots the spawn sidecar at launch time, then completes (or never starts). */
function fakeHerdr(root: string): void {
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
elif args[:2] == ["pane", "run"]:
    text = open(shlex.split(args[3])[-1]).read()
    m = re.search(r"PI_SUBAGENT_SESSION='([^']+)'", text)
    if m:
        s = m.group(1)
        os.makedirs(os.path.dirname(s), exist_ok=True)
        if not os.path.exists(s):
            with open(s, "w") as f:
                f.write(json.dumps({"type": "session", "version": 3, "id": "child-id", "cwd": os.path.dirname(os.path.dirname(os.path.abspath(__file__)))}) + "\\n")
        try:
            n = len([f for f in os.listdir(os.path.dirname(s)) if f.startswith(os.path.basename(s) + ".at-launch.")])
            open(s + ".at-launch." + str(n), "w").write(open(s + ".spawn.json").read())
        except FileNotFoundError:
            pass
        if os.path.exists(os.path.join(os.path.dirname(os.path.abspath(__file__)), "hold")):
            sys.exit(0)
        with open(s, "a") as f:
            f.write(json.dumps({"type": "message", "message": {"role": "assistant", "stopReason": "stop", "content": [{"type": "text", "text": "done"}]}}) + "\\n")
        with open(s + ".exit", "w") as f:
            json.dump({"type": "done"}, f)
`, "utf8");
  chmodSync(command, 0o755);
  process.env.PATH = `${bin}:${originalEnv.PATH ?? ""}`;
}

function fixture(opts: { failWatcher?: boolean } = {}) {
  const root = mkdtempSync(join(SCRATCH, "task313-label-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  mkdirSync(join(agentDir, "agents"), { recursive: true });
  writeFileSync(join(agentDir, "agents", "task313worker.md"), "---\nname: task313worker\n---\nYou are a test worker.\n", "utf8");
  const parent = join(root, "parent.jsonl");
  writeFileSync(parent, JSON.stringify({ type: "session", version: 3, id: "parent-id", cwd: root }) + "\n", "utf8");
  fakeHerdr(root);
  if (opts.failWatcher) writeFileSync(join(root, "bin", "hold"), "");
  Object.assign(process.env, {
    HERDR_ENV: "1", HERDR_PANE_ID: "parent-pane", HERDR_TAB_ID: "parent-tab", HERDR_WORKSPACE_ID: "parent-workspace",
    PI_CODING_AGENT_DIR: agentDir, PI_SUBAGENT_SHELL_READY_DELAY_MS: "0",
  });
  delete process.env.PI_SUBAGENT_ID;
  delete process.env.PI_SUBAGENT_AGENT;
  __herdrTest__.clearCommandAvailability();

  const handlers = new Map<string, Function>();
  const tools = new Map<string, any>();
  const sent: any[] = [];
  let broken = false;
  const api = {
    on(event: string, handler: Function) { handlers.set(event, handler); },
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand() {}, registerMessageRenderer() {}, registerShortcut() {},
    getAllTools() { return []; }, getThinkingLevel() { return "medium"; },
    sendUserMessage() {}, appendEntry() {},
    sendMessage(message: any) { sent.push(message); },
  } as any;
  const ctx = {
    cwd: root, hasUI: true, mode: "tui", isProjectTrusted: () => true,
    model: { provider: "fake", id: "parent" },
    modelRegistry: { find: () => ({ provider: "fake", id: "parent", reasoning: true }), getAvailable: () => [], hasConfiguredAuth: () => true },
    sessionManager: { getSessionFile: () => parent, getSessionId: () => "parent-id", getSessionDir: () => root },
    ui: {
      notify() {},
      setWidget() {
        if (!broken || !new Error().stack!.includes("watchSubagent")) return;
        throw new Error("task313 injected watcher failure");
      },
      setStatus() {},
    },
  } as any;
  subagentsExtension(api);
  handlers.get("session_start")?.({}, ctx);
  cleanups.push(() => handlers.get("session_shutdown")?.({ reason: "exit" }, ctx));
  const spawn = (extra: Record<string, unknown> = {}) =>
    tools.get("subagent").execute("t", { name: "task313worker", agent: "task313worker", task: "same task", interactive: false, ...extra }, undefined, undefined, ctx);
  const resume = (params: Record<string, unknown>) =>
    tools.get("subagent_resume").execute("t", params, undefined, undefined, ctx);
  const waitFor = async (count: number) => {
    const deadline = Date.now() + 8000;
    while (sent.filter((m) => m.customType === "subagent_result").length < count && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return sent.filter((m) => m.customType === "subagent_result");
  };
  return { root, sent, spawn, resume, waitFor, breakWatcher: () => { broken = opts.failWatcher ?? true; } };
}

const launchSnapshot = (session: string, n = 0) => JSON.parse(readFileSync(`${session}.at-launch.${n}`, "utf8"));

describe("TASK-313 delegation label producer propagation", () => {
  it("labels: two same-profile same-task spawns propagate their own labels, registered before launch", async () => {
    const f = fixture();
    const a = await f.spawn({ delegation_id: "deep:TASK-313-a" });
    const b = await f.spawn({ delegation_id: "deep:TASK-313-b" });
    assert.equal(a.details.delegationId, "deep:TASK-313-a");
    assert.equal(b.details.delegationId, "deep:TASK-313-b");
    assert.equal(a.details.runId, a.details.id, "runId aliases the unchanged started id");
    assert.notEqual(a.details.completionId, b.details.completionId);
    for (const started of [a, b]) {
      const meta = launchSnapshot(started.details.sessionFile);
      assert.equal(meta.delegationId, started.details.delegationId, "durable before the child ran");
      assert.equal(meta.completionId, started.details.completionId);
      assert.equal(meta.attemptTask, "same task");
      assert.equal(meta.runId, started.details.id);
      assert.equal(meta.childSessionFile, started.details.sessionFile);
    }
    const results = await f.waitFor(2);
    assert.equal(results.length, 2);
    for (const started of [a, b]) {
      const result = results.find((m) => m.details.completionId === started.details.completionId);
      assert.ok(result, "completion for each attempt");
      assert.equal(result.details.delegationId, started.details.delegationId);
      assert.equal(result.details.runId, started.details.id);
      assert.equal(result.details.sessionFile, started.details.sessionFile);
    }
  });

  it("absent: no label is ever invented from the task or name", async () => {
    const f = fixture();
    const a = await f.spawn();
    assert.ok(!("delegationId" in a.details));
    assert.ok(!("delegationId" in launchSnapshot(a.details.sessionFile)));
    const [result] = await f.waitFor(1);
    assert.ok(!("delegationId" in result.details));
    assert.equal(result.details.runId, a.details.id);
    const bad = await f.spawn({ delegation_id: "   " });
    assert.match(bad.content[0].text, /delegation_id/);
    assert.equal(bad.details.status, "refused");
  });

  it("error: the rejected-watcher completion carries the label and runId", async () => {
    const f = fixture({ failWatcher: true });
    const started = await f.spawn({ delegation_id: "deep:TASK-313-err" });
    f.breakWatcher();
    const [result] = await f.waitFor(1);
    assert.equal(result.details.error, "task313 injected watcher failure");
    assert.equal(result.details.delegationId, "deep:TASK-313-err");
    assert.equal(result.details.runId, started.details.id);
    assert.equal(result.details.completionId, started.details.completionId);
  });

  it("resume: inherits the durable label, accepts the same one idempotently, refuses a conflicting one", async () => {
    const f = fixture();
    const first = await f.spawn({ delegation_id: "deep:TASK-313-r" });
    await f.waitFor(1);
    const session = first.details.sessionFile;

    const inherited = await f.resume({ sessionPath: session, message: "continue one" });
    assert.equal(inherited.details.delegationId, "deep:TASK-313-r");
    assert.equal(inherited.details.runId, inherited.details.id);
    assert.equal(launchSnapshot(session, 1).delegationId, "deep:TASK-313-r");
    assert.notEqual(inherited.details.completionId, first.details.completionId);
    let results = await f.waitFor(2);
    assert.equal(results[1].details.delegationId, "deep:TASK-313-r");
    assert.equal(results[1].details.completionId, inherited.details.completionId);

    const same = await f.resume({ sessionPath: session, message: "continue two", delegation_id: "deep:TASK-313-r" });
    assert.equal(same.details.delegationId, "deep:TASK-313-r");
    assert.equal(launchSnapshot(session, 2).delegationId, "deep:TASK-313-r");
    results = await f.waitFor(3);
    assert.equal(results[2].details.delegationId, "deep:TASK-313-r");

    const before = readFileSync(`${session}.spawn.json`, "utf8");
    const conflict = await f.resume({ sessionPath: session, message: "continue three", delegation_id: "deep:OTHER" });
    assert.equal(conflict.details.status, "refused");
    assert.equal(conflict.details.error, "delegation label mismatch");
    assert.equal(readFileSync(`${session}.spawn.json`, "utf8"), before, "metadata untouched by the refusal");
    assert.ok(!existsSync(`${session}.at-launch.3`), "nothing launched");
  });

  it("resume without a durable label records an explicit one", async () => {
    const f = fixture();
    const first = await f.spawn();
    await f.waitFor(1);
    const session = first.details.sessionFile;
    const resumed = await f.resume({ sessionPath: session, message: "go", delegation_id: "deep:TASK-313-late" });
    assert.equal(resumed.details.delegationId, "deep:TASK-313-late");
    assert.equal(launchSnapshot(session, 1).delegationId, "deep:TASK-313-late");
  });

  it("orphan discovery retains the attempt identity and label", () => {
    const root = mkdtempSync(join(SCRATCH, "task313-orphan-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const parent = join(root, "parent.jsonl");
    const child = join(root, "child.jsonl");
    writeFileSync(parent, JSON.stringify({ type: "session", version: 3, id: "parent-id", cwd: root }) + "\n");
    writeFileSync(child, JSON.stringify({ type: "session", version: 3, id: "child-id", cwd: root }) + "\n");
    writeFileSync(`${child}.spawn.json`, JSON.stringify({
      parentSessionFile: parent, parentSessionId: "parent-id", childSessionFile: child, name: "w", task: "t",
      completionId: "c-1", attemptTask: "brief", delegationId: "deep:TASK-313-o", runId: "r-1", allowance: 0,
    }));
    const found = discoverOrphanedSubagents(parent, { sessionDir: root, parentSessionId: "parent-id" });
    const meta = found.find((o) => o.sessionFile === child)?.spawnMetadata;
    assert.deepEqual(
      [meta?.completionId, meta?.attemptTask, meta?.delegationId, meta?.runId],
      ["c-1", "brief", "deep:TASK-313-o", "r-1"],
    );
  });
});
