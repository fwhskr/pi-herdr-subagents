import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import subagentsExtension, { __test__ as subagentsTest } from "../pi-extension/subagents/index.ts";
import { __herdrTest__ } from "../pi-extension/subagents/herdr.ts";

// TASK-313 durable resume identity: a session with NO spawn metadata (no
// first-launch .spawn.json sidecar) that receives an explicit delegation_id on
// resume must have that label durable BEFORE the child runs, in a minimal
// identity record that grants no spawn rights and fabricates no lineage. The
// absent-metadata spawn clamp (deny) is unchanged; a conflicting label is
// still refused; metadata-present resumes keep .spawn.json as their only
// durable home.
// Run: timeout 60 node --test test/task313-delegation-record.test.ts

const SCRATCH = "/home/kris/.pi/agent/var";
const ENV_NAMES = [
  "HERDR_ENV", "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID", "PATH",
  "PI_CODING_AGENT_DIR", "PI_SUBAGENT_ID", "PI_SUBAGENT_AGENT", "PI_SUBAGENT_SHELL_READY_DELAY_MS",
  "PI_SUBAGENT_SPAWN_DEPTH", "PI_VERIFIER_SCOPE_AUTH",
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

/** Fake herdr: at pane-run time snapshots the durable identity evidence, then completes (or holds). */
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
        def count(prefix):
            return len([f for f in os.listdir(os.path.dirname(s)) if f.startswith(os.path.basename(s) + prefix)])
        try:
            metadata = open(s + ".spawn.json").read()
            open(s + ".at-launch." + str(count(".at-launch.")), "w").write(metadata)
        except FileNotFoundError:
            pass
        try:
            identity = open(s + ".delegation.json").read()
            open(s + ".at-launch-delegation." + str(count(".at-launch-delegation.")), "w").write(identity)
        except OSError:
            pass
        env = {}
        m2 = re.search(r"PI_DENY_TOOLS='([^']*)'", text)
        if m2:
            env["PI_DENY_TOOLS"] = m2.group(1)
        m3 = re.search(r"PI_SUBAGENT_SPAWN_DEPTH=([0-9]+)", text)
        if m3:
            env["PI_SUBAGENT_SPAWN_DEPTH"] = m3.group(1)
        open(s + ".at-launch-env." + str(count(".at-launch-env.")), "w").write(json.dumps(env))
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

function fixture(opts: { hold?: boolean } = {}) {
  const root = mkdtempSync(join(SCRATCH, "task313-record-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  mkdirSync(join(agentDir, "agents"), { recursive: true });
  writeFileSync(join(agentDir, "agents", "task313worker.md"), "---\nname: task313worker\n---\nYou are a test worker.\n", "utf8");
  const parent = join(root, "parent.jsonl");
  writeFileSync(parent, JSON.stringify({ type: "session", version: 3, id: "parent-id", cwd: root }) + "\n", "utf8");
  fakeHerdr(root);
  if (opts.hold) writeFileSync(join(root, "bin", "hold"), "");
  const releaseHold = () => rmSync(join(root, "bin", "hold"), { force: true });
  Object.assign(process.env, {
    HERDR_ENV: "1", HERDR_PANE_ID: "parent-pane", HERDR_TAB_ID: "parent-tab", HERDR_WORKSPACE_ID: "parent-workspace",
    PI_CODING_AGENT_DIR: agentDir, PI_SUBAGENT_SHELL_READY_DELAY_MS: "0",
  });
  delete process.env.PI_SUBAGENT_ID;
  delete process.env.PI_SUBAGENT_AGENT;
  delete process.env.PI_SUBAGENT_SPAWN_DEPTH;
  delete process.env.PI_VERIFIER_SCOPE_AUTH;
  __herdrTest__.clearCommandAvailability();

  const ctx = {
    cwd: root, hasUI: true, mode: "tui", isProjectTrusted: () => true,
    model: { provider: "fake", id: "parent" },
    modelRegistry: { find: () => ({ provider: "fake", id: "parent", reasoning: true }), getAvailable: () => [], hasConfiguredAuth: () => true },
    sessionManager: { getSessionFile: () => parent, getSessionId: () => "parent-id", getSessionDir: () => root },
    ui: { notify() {}, setWidget() {}, setStatus() {} },
  } as any;

  const shutdowns: Array<() => void> = [];
  cleanups.push(() => { for (const fn of shutdowns.splice(0)) fn(); });
  const shutdownAll = () => { for (const fn of shutdowns.splice(0)) fn(); };

  /** One extension instance bound to the shared parent ctx. Recovery attaches a fresh one. */
  const attach = () => {
    const handlers = new Map<string, Function>();
    const tools = new Map<string, any>();
    const sent: any[] = [];
    const api = {
      on(event: string, handler: Function) { handlers.set(event, handler); },
      registerTool(tool: any) { tools.set(tool.name, tool); },
      registerCommand() {}, registerMessageRenderer() {}, registerShortcut() {},
      getAllTools() { return []; }, getThinkingLevel() { return "medium"; },
      sendUserMessage() {}, appendEntry() {},
      sendMessage(message: any) { sent.push(message); },
    } as any;
    subagentsExtension(api);
    handlers.get("session_start")?.({}, ctx);
    shutdowns.push(() => handlers.get("session_shutdown")?.({ reason: "exit" }, ctx));
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
    return { sent, spawn, resume, waitFor };
  };

  const bareChild = () => {
    const child = join(root, `child-${Math.random().toString(16).slice(2, 8)}.jsonl`);
    writeFileSync(child, JSON.stringify({ type: "session", version: 3, id: "child-id", cwd: root }) + "\n", "utf8");
    return child;
  };

  return { root, attach, bareChild, releaseHold, shutdownAll };
}

const launchDelegationSnapshot = (session: string, n: number) =>
  JSON.parse(readFileSync(`${session}.at-launch-delegation.${n}`, "utf8"));
const launchEnvSnapshot = (session: string, n: number) =>
  JSON.parse(readFileSync(`${session}.at-launch-env.${n}`, "utf8"));

describe("TASK-313 durable delegation identity without spawn metadata", () => {
  it("durable: an explicit label on a metadata-less session is recorded before the child runs", async () => {
    const f = fixture();
    const child = f.bareChild();
    const instance = f.attach();
    const started = await instance.resume({ sessionPath: child, message: "finish the brief", delegation_id: "deep:TASK-313-d1" });
    assert.equal(started.details.delegationId, "deep:TASK-313-d1");
    const [result] = await instance.waitFor(1);
    assert.equal(result.details.delegationId, "deep:TASK-313-d1");
    assert.equal(result.details.runId, started.details.id);
    // Durable BEFORE the child ran: the fake herdr snapshots the record at
    // pane-run time, before its completion markers.
    assert.ok(existsSync(`${child}.at-launch-delegation.0`), "label must be durable before launch");
    const snapshot = launchDelegationSnapshot(child, 0);
    assert.equal(snapshot.delegationId, "deep:TASK-313-d1");
    assert.equal(snapshot.completionId, started.details.completionId);
    assert.equal(snapshot.runId, started.details.id);
    // The record never fabricates spawn metadata or any rights with it.
    assert.ok(!existsSync(`${child}.spawn.json`));
    assert.ok(!existsSync(`${child}.at-launch.0`));
  });

  it("clamp: the metadata-less resume keeps the deny-only spawn rights and invents nothing", async () => {
    const f = fixture();
    const child = f.bareChild();
    const instance = f.attach();
    const started = await instance.resume({ sessionPath: child, message: "go", delegation_id: "deep:TASK-313-c1" });
    assert.equal(started.details.delegationId, "deep:TASK-313-c1");
    const [result] = await instance.waitFor(1);
    assert.equal(result.details.delegationId, "deep:TASK-313-c1");
    const env = launchEnvSnapshot(child, 0);
    assert.match(env.PI_DENY_TOOLS ?? "", /subagent_resume/, "spawning tools stay denied");
    assert.equal(env.PI_SUBAGENT_SPAWN_DEPTH, "0", "child depth clamped to zero");
    assert.ok(!existsSync(`${child}.spawn.json`), "no spawn metadata fabricated");
    assert.deepEqual(subagentsTest.clampResumeSpawn(null, 5), { maySpawn: false, childEnvDepth: 0 });
    const child2 = f.bareChild();
    const quiet = await instance.resume({ sessionPath: child2, message: "quiet go" });
    assert.ok(!("delegationId" in quiet.details), "no label invented");
    await instance.waitFor(2);
    assert.ok(!existsSync(`${child2}.delegation.json`), "no record without a label");
  });

  it("retained: a crash mid-run keeps the label for the next resume", async () => {
    const f = fixture({ hold: true });
    const child = f.bareChild();
    const first = f.attach();
    const started = await first.resume({ sessionPath: child, message: "long attempt", delegation_id: "deep:TASK-313-r1" });
    assert.equal(started.details.delegationId, "deep:TASK-313-r1");
    assert.ok(existsSync(`${child}.delegation.json`));
    f.shutdownAll(); // the parent goes down mid-run; nothing completes
    f.releaseHold();
    const recovered = f.attach();
    const resumed = await recovered.resume({ sessionPath: child, message: "continue after crash" });
    assert.equal(resumed.details.delegationId, "deep:TASK-313-r1", "label inherited from the durable record");
    assert.notEqual(resumed.details.completionId, started.details.completionId);
    const [result] = await recovered.waitFor(1);
    assert.equal(result.details.delegationId, "deep:TASK-313-r1");
    const snapshot = launchDelegationSnapshot(child, 1);
    assert.equal(snapshot.delegationId, "deep:TASK-313-r1");
    assert.equal(snapshot.completionId, resumed.details.completionId);
    assert.ok(!existsSync(`${child}.spawn.json`), "still no fabricated spawn metadata");
  });

  it("conflict: a different explicit label is refused against the record", async () => {
    const f = fixture();
    const child = f.bareChild();
    const instance = f.attach();
    const started = await instance.resume({ sessionPath: child, message: "first", delegation_id: "deep:TASK-313-k1" });
    await instance.waitFor(1);
    const same = await instance.resume({ sessionPath: child, message: "same exact label", delegation_id: "deep:TASK-313-k1" });
    assert.equal(same.details.delegationId, started.details.delegationId);
    assert.notEqual(same.details.completionId, started.details.completionId);
    const results = await instance.waitFor(2);
    assert.equal(results[1].details.delegationId, "deep:TASK-313-k1");
    assert.equal(launchDelegationSnapshot(child, 1).completionId, same.details.completionId);
    const before = readFileSync(`${child}.delegation.json`, "utf8");
    const conflict = await instance.resume({ sessionPath: child, message: "second", delegation_id: "deep:OTHER" });
    assert.equal(conflict.details.status, "refused");
    assert.equal(conflict.details.error, "delegation label mismatch");
    assert.equal(readFileSync(`${child}.delegation.json`, "utf8"), before, "record untouched by the refusal");
    assert.ok(!existsSync(`${child}.at-launch-env.2`), "nothing launched on conflict");
  });

  it("exclusive: metadata-present resumes keep .spawn.json as the only durable home", async () => {
    const f = fixture();
    const instance = f.attach();
    const a = await instance.spawn({ delegation_id: "deep:TASK-313-m1" });
    await instance.waitFor(1);
    await instance.resume({ sessionPath: a.details.sessionFile, message: "again", delegation_id: "deep:TASK-313-m1" });
    await instance.waitFor(2);
    assert.ok(!existsSync(`${a.details.sessionFile}.delegation.json`), "no shadow record beside live metadata");
    const b = await instance.spawn();
    await instance.waitFor(3);
    const rb = await instance.resume({ sessionPath: b.details.sessionFile, message: "late label", delegation_id: "deep:TASK-313-m2" });
    assert.equal(rb.details.delegationId, "deep:TASK-313-m2");
    assert.equal(JSON.parse(readFileSync(`${b.details.sessionFile}.at-launch.1`, "utf8")).delegationId, "deep:TASK-313-m2");
    assert.ok(!existsSync(`${b.details.sessionFile}.delegation.json`), "the label lands in metadata, not a record");
  });

  it("impossible: an undurable explicit label refuses before launch", async () => {
    const f = fixture();
    const child = f.bareChild();
    mkdirSync(`${child}.delegation.json`); // the record path can never be written
    cleanups.push(() => rmSync(`${child}.delegation.json`, { recursive: true, force: true }));
    const refused = await f.attach().resume({ sessionPath: child, message: "must refuse", delegation_id: "deep:TASK-313-x" });
    assert.equal(refused.details.status, "refused");
    assert.equal(refused.details.error, "delegation label not durable");
    assert.ok(!existsSync(`${child}.at-launch-env.0`), "nothing launched on write failure");
    assert.ok(!existsSync(`${child}.spawn.json`));
  });
});
