import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import subagentsExtension, { __test__ as subagentsTest } from "../pi-extension/subagents/index.ts";
import { __herdrTest__ } from "../pi-extension/subagents/herdr.ts";
import { CompletionDelivery } from "../pi-extension/subagents/completion-delivery.ts";

// TASK-462: one process-wide CompletionDelivery held ONE bound API, rebound by
// every session_start, so a child completion enqueued by session A's watcher was
// delivered through session B's API when B bound last. Measured instance
// 2026-09-26T06:39:58Z: lane 8e332cdf of session 01a0dc61-6cca delivered into
// sibling 01a0dc61-6cc5, which then resumed it as run fb411865. Two real
// extension loads (two fake pi APIs, as pi's per-session jiti loads give) share
// the real process-global runtime; fake herdr, real subagent tools.
//
// Run: timeout 90 node --test --test-name-pattern='<selector>' test/task462-completion-routing.test.ts
// Selectors: "AC1 misdelivery", "AC2 measured instance", "AC3 single session",
//            "AC4 no-bind waits", "AC4 terminal teardown", "AC4 different projects"

const ENV_NAMES = [
  "HERDR_ENV", "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID", "PATH",
  "PI_CODING_AGENT_DIR", "PI_SUBAGENT_ID", "PI_SUBAGENT_AGENT", "PI_SUBAGENT_SHELL_READY_DELAY_MS",
] as const;
const originalEnv = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
const roots: string[] = [];
const live: Session[] = [];

afterEach(() => {
  for (const session of live.splice(0)) session.shutdown("exit");
  subagentsTest.runningSubagents.clear();
  for (const name of ENV_NAMES) {
    const value = originalEnv[name];
    if (value == null) delete process.env[name];
    else process.env[name] = value;
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "task462-"));
  roots.push(root);
  return root;
}

/** Fake herdr: panes exist and accept commands; children finish only when the test says so. */
function environment(): void {
  const root = tempRoot();
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
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
`, "utf8");
  chmodSync(join(bin, "herdr"), 0o755);
  const agentDir = join(root, "agent");
  mkdirSync(join(agentDir, "agents"), { recursive: true });
  writeFileSync(join(agentDir, "agents", "worker.md"), "---\nname: worker\n---\nYou are a test worker.\n", "utf8");
  Object.assign(process.env, {
    PATH: `${bin}:${originalEnv.PATH ?? ""}`,
    HERDR_ENV: "1", HERDR_PANE_ID: "parent-pane", HERDR_TAB_ID: "parent-tab", HERDR_WORKSPACE_ID: "parent-workspace",
    PI_CODING_AGENT_DIR: agentDir, PI_SUBAGENT_SHELL_READY_DELAY_MS: "0",
  });
  delete process.env.PI_SUBAGENT_ID;
  delete process.env.PI_SUBAGENT_AGENT;
  __herdrTest__.clearCommandAvailability();
}

type Sent = { customType: string; content: string; details: Record<string, any> };

/** One pi session: its own extension load (own `pi` API = own transcript) over the shared runtime. */
class Session {
  readonly root = tempRoot();
  readonly parentFile = join(this.root, "parent.jsonl");
  handlers = new Map<string, Function>();
  tools: any[] = [];
  transcript: Sent[] = [];
  ctx: any;
  readonly id: string;

  constructor(id: string) {
    this.id = id;
    writeFileSync(this.parentFile, JSON.stringify({ type: "session", version: 3, id, cwd: this.root }) + "\n", "utf8");
    this.ctx = {
      cwd: this.root, hasUI: true, mode: "tui", isProjectTrusted: () => true,
      model: { provider: "fake", id: "parent" },
      modelRegistry: { find: () => ({ provider: "fake", id: "parent", reasoning: true }), getAvailable: () => [], hasConfiguredAuth: () => true },
      sessionManager: { getSessionFile: () => this.parentFile, getSessionId: () => id, getSessionDir: () => this.root },
      ui: { notify() {}, setWidget() {}, setStatus() {} },
    };
    this.load();
  }

  /** A fresh extension load, as pi does on startup and on /reload. */
  load(): void {
    const handlers = new Map<string, Function>();
    const tools: any[] = [];
    const transcript: Sent[] = [];
    this.handlers = handlers;
    this.tools = tools;
    this.transcript = transcript;
    subagentsExtension({
      on(event: string, handler: Function) { handlers.set(event, handler); },
      registerTool(tool: any) { tools.push(tool); },
      registerCommand() {}, registerMessageRenderer() {}, registerShortcut() {},
      getAllTools() { return []; },
      getThinkingLevel() { return "medium"; },
      sendUserMessage() {}, appendEntry() {},
      sendMessage(message: Sent) { transcript.push(message); },
    } as any);
  }

  start(): this {
    this.handlers.get("session_start")?.({}, this.ctx);
    if (!live.includes(this)) live.push(this);
    return this;
  }

  shutdown(reason: string): void {
    this.handlers.get("session_shutdown")?.({ reason }, this.ctx);
  }

  results(): Sent[] {
    return this.transcript.filter((m) => m.customType === "subagent_result");
  }

  async spawn(name: string): Promise<string> {
    const tool = this.tools.find((candidate) => candidate.name === "subagent");
    const result = await tool.execute(name, { name, agent: "worker", task: `task for ${name}`, interactive: false }, undefined, undefined, this.ctx);
    assert.match(result.content[0].text, /launched and is now running/);
    const scripts = join(this.root, "artifacts", this.id, "subagent-scripts");
    const script = readdirSync(scripts).map((n) => readFileSync(join(scripts, n), "utf8")).find((t) => t.includes(`task for ${name}`)) ?? readFileSync(join(scripts, readdirSync(scripts)[0]), "utf8");
    return /PI_SUBAGENT_SESSION='([^']+)'/.exec(script)![1];
  }

  async resume(name: string): Promise<string> {
    const child = join(this.root, `${name}.jsonl`);
    writeFileSync(child, JSON.stringify({ type: "session", version: 3, id: `${name}-child`, cwd: this.root }) + "\n", "utf8");
    const tool = this.tools.find((candidate) => candidate.name === "subagent_resume");
    const result = await tool.execute(name, { sessionPath: child, name, message: "continue" }, undefined, undefined, this.ctx);
    assert.match(result.content[0].text, /resumed/);
    return child;
  }
}

/** The child writes its final report and its done sidecar. */
function finish(childSession: string, text: string): void {
  mkdirSync(join(childSession, ".."), { recursive: true });
  appendFileSync(childSession, JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } }) + "\n");
  writeFileSync(`${childSession}.exit`, JSON.stringify({ type: "done" }));
}

async function until(predicate: () => boolean, ms = 8_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
}

/** Let any misdelivery that is going to happen, happen. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 1_500));

function report(label: string, sessions: Session[]): void {
  console.log(`   [${label}] ` + sessions.map((s) => `${s.id}: ${JSON.stringify(s.results().map((m) => m.details?.name))}`).join("  "));
}

describe("TASK-462 completion routing", () => {
  it("AC1 misdelivery: a child completion reaches the session that spawned it, not the last-bound sibling", async () => {
    environment();
    const owner = new Session("ac1-owner").start();
    const sibling = new Session("ac1-sibling").start(); // binds LAST
    const child = await owner.spawn("ac1-lane");
    finish(child, "owner lane report");
    await until(() => owner.results().length + sibling.results().length > 0);
    await settle();
    report("AC1", [owner, sibling]);
    assert.deepEqual(sibling.results(), [], "the sibling session's transcript received another session's child result");
    assert.equal(owner.results().length, 1, "the owner receives its child result exactly once");
    assert.match(owner.results()[0].content, /owner lane report/);
  });

  it("AC2 measured instance: 6cca's lane 8e332cdf never lands in 6cc5 (no fb411865 resume trigger)", async () => {
    environment();
    // 6cca owns lane 8e332cdf (spawned, later resumed); 6cc5 is the sibling that bound last.
    const s6cca = new Session("01a0dc61-6cca-72e2-b2fb-8e6f23ceb14b").start();
    const s6cc5 = new Session("01a0dc61-6cc5-72e2-b2fb-8e6c0baa9ee8").start();
    const spawned = await s6cca.spawn("8e332cdf");
    finish(spawned, "lane 8e332cdf spawn result");
    await until(() => s6cca.results().length + s6cc5.results().length > 0);
    const resumed = await s6cca.resume("8e332cdf-resume");
    finish(resumed, "lane 8e332cdf resume result");
    await until(() => s6cca.results().length + s6cc5.results().length > 1);
    await settle();
    report("AC2", [s6cca, s6cc5]);
    assert.deepEqual(s6cc5.results(), [], "6cc5 received 6cca's child result (the fb411865 trigger)");
    assert.deepEqual(s6cca.results().map((m) => m.content.match(/lane 8e332cdf (\w+) result/)?.[1]), ["spawn", "resume"]);
  });

  it("AC3 single session: bind -> enqueue -> drain delivers once, as before", async () => {
    environment();
    const only = new Session("ac3-only").start();
    const child = await only.spawn("ac3-lane");
    finish(child, "single session report");
    await until(() => only.results().length > 0);
    await settle();
    report("AC3", [only]);
    assert.equal(only.results().length, 1);
    assert.match(only.results()[0].content, /single session report/);

    // Class level, no owner argument: identical to the pre-TASK-462 contract.
    const delivery = new CompletionDelivery<string>();
    const seen: string[] = [];
    const queued = delivery.enqueue((api) => seen.push(`queued@${api}`));
    assert.deepEqual(seen, []);
    delivery.bind("api-1");
    await queued;
    await delivery.enqueue((api) => seen.push(`immediate@${api}`));
    delivery.bind("api-2");
    await delivery.enqueue((api) => seen.push(`rebound@${api}`));
    assert.deepEqual(seen, ["queued@api-1", "immediate@api-1", "rebound@api-2"]);
  });

  it("AC4 no-bind waits: a completion while the owner is unbound waits for the owner's rebind, exactly once", async () => {
    environment();
    const owner = new Session("ac4-wait-owner").start();
    const sibling = new Session("ac4-wait-sibling").start();
    const child = await owner.spawn("ac4-wait-lane");
    owner.shutdown("reload"); // owner unbound; sibling stays bound
    const stale = owner.transcript;
    finish(child, "completed during reload");
    await settle();
    assert.deepEqual(sibling.results(), [], "a completion queued while its owner is unbound must not drain into a bound sibling");
    assert.deepEqual(stale.filter((m) => m.customType === "subagent_result"), []);
    owner.load(); // /reload: fresh API for the same session
    owner.start();
    await until(() => owner.results().length > 0);
    owner.start(); // a second bind must not redeliver
    await settle();
    report("AC4-wait", [owner, sibling]);
    assert.equal(owner.results().length, 1, "delivered exactly once on the owner's next bind");
    assert.match(owner.results()[0].content, /completed during reload/);
    assert.deepEqual(sibling.results(), []);
  });

  it("AC4 terminal teardown: detach without preserve resolves only that session's pending entries", async () => {
    const delivery = new CompletionDelivery<string>();
    const ran: string[] = [];
    const a = delivery.enqueue((api) => ran.push(`a@${api}`), "A");
    const b = delivery.enqueue((api) => ran.push(`b@${api}`), "B");
    delivery.detach(false, "A"); // terminal teardown of A
    await a; // resolved without running, as today
    await delivery.enqueue(() => ran.push("late-a"), "A"); // late completion suppressed
    delivery.bind("api-A2", "A2");
    delivery.bind("api-B", "B");
    await b;
    assert.deepEqual(ran, ["b@api-B"], "A's teardown suppresses A only; B still delivers to B");

    // Single-owner teardown is unchanged: queued and late completions are suppressed.
    const single = new CompletionDelivery<object>();
    const queued = single.enqueue(() => assert.fail("queued terminal delivery"));
    single.detach(false);
    await queued;
    await single.enqueue(() => assert.fail("late terminal delivery"));
    single.bind({});
  });

  it("AC4 different projects: non-Nova sessions of two projects each receive only their own results", async () => {
    environment();
    const lumi = new Session("proj-lumi-session").start();
    const norni = new Session("proj-norni-session").start();
    assert.notEqual(lumi.root, norni.root);
    const lumiChild = await lumi.spawn("lumi-lane");
    const norniChild = await norni.spawn("norni-lane");
    finish(norniChild, "norni report");
    finish(lumiChild, "lumi report");
    await until(() => lumi.results().length + norni.results().length > 1);
    await settle();
    report("AC4-projects", [lumi, norni]);
    assert.deepEqual(lumi.results().map((m) => m.details?.name), ["lumi-lane"]);
    assert.deepEqual(norni.results().map((m) => m.details?.name), ["norni-lane"]);
  });
});
