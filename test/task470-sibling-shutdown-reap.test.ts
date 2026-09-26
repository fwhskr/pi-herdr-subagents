import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import subagentsExtension, { __test__ as subagentsTest } from "../pi-extension/subagents/index.ts";
import { __herdrTest__ } from "../pi-extension/subagents/herdr.ts";

// TASK-470: the session_shutdown handler (index.ts:3047 @ fad7812) passed the
// process-wide running Map to cleanupSubagentsForShutdown (:1236-1252), whose
// only preservation is reason === "reload" (:1232-1234). A terminal shutdown of
// one session therefore aborted, suppressed and cleared every sibling session's
// running lanes. Two real extension loads share the real process-global
// runtime; fake herdr, real subagent tools, real session_shutdown handler.
//
// Run: timeout 90 node --test --test-name-pattern='<selector>' test/task470-sibling-shutdown-reap.test.ts
// Selectors: "AC1 sibling shutdown", "AC3 reload preserves", "AC3 own lanes cleaned"

const ENV_NAMES = [
  "HERDR_ENV", "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID", "PATH",
  "PI_CODING_AGENT_DIR", "PI_SUBAGENT_ID", "PI_SUBAGENT_AGENT", "PI_SUBAGENT_SHELL_READY_DELAY_MS",
] as const;
const originalEnv = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
const roots: string[] = [];
const live: Session[] = [];

afterEach(() => {
  for (const session of live.splice(0)) session.shutdown("quit");
  for (const running of subagentsTest.runningSubagents.values()) (running as any).abortController?.abort();
  subagentsTest.runningSubagents.clear();
  for (const name of ENV_NAMES) {
    const value = originalEnv[name];
    if (value == null) delete process.env[name];
    else process.env[name] = value;
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "task470-"));
  roots.push(root);
  return root;
}

/** Fake herdr: panes exist and accept commands; children never finish on their own. */
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

/** One pi session: its own extension load and its own UI over the shared runtime. */
class Session {
  readonly root = tempRoot();
  readonly parentFile = join(this.root, "parent.jsonl");
  handlers = new Map<string, Function>();
  tools: any[] = [];
  ctx: any;

  constructor(id: string) {
    writeFileSync(this.parentFile, JSON.stringify({ type: "session", version: 3, id, cwd: this.root }) + "\n", "utf8");
    this.ctx = {
      cwd: this.root, hasUI: false, mode: "tui", isProjectTrusted: () => true,
      model: { provider: "fake", id: "parent" },
      modelRegistry: { find: () => ({ provider: "fake", id: "parent", reasoning: true }), getAvailable: () => [], hasConfiguredAuth: () => true },
      sessionManager: { getSessionFile: () => this.parentFile, getSessionId: () => id, getSessionDir: () => this.root },
      ui: { notify() {}, setStatus() {}, setWidget() {} },
    };
    const handlers = this.handlers;
    const tools = this.tools;
    subagentsExtension({
      on(event: string, handler: Function) { handlers.set(event, handler); },
      registerTool(tool: any) { tools.push(tool); },
      registerCommand() {}, registerMessageRenderer() {}, registerShortcut() {},
      getAllTools() { return []; },
      getThinkingLevel() { return "medium"; },
      sendUserMessage() {}, appendEntry() {}, sendMessage() {},
    } as any);
    this.handlers.get("session_start")?.({}, this.ctx);
    live.push(this);
  }

  shutdown(reason: string): void {
    this.handlers.get("session_shutdown")?.({ reason }, this.ctx);
  }

  /** Spawn a lane; returns its running entry. */
  async spawn(name: string): Promise<any> {
    const tool = this.tools.find((candidate) => candidate.name === "subagent");
    const before = new Set(subagentsTest.runningSubagents.keys());
    const result = await tool.execute(name, { name, agent: "worker", task: `task for ${name}`, interactive: false }, undefined, undefined, this.ctx);
    assert.match(result.content[0].text, /launched and is now running/);
    const added = Array.from(subagentsTest.runningSubagents.keys()).filter((id) => !before.has(id));
    assert.equal(added.length, 1);
    return subagentsTest.runningSubagents.get(added[0]);
  }

  async interrupt(name: string): Promise<{ text: string; details: any }> {
    const tool = this.tools.find((candidate) => candidate.name === "subagent_interrupt");
    const result = await tool.execute("interrupt", { name }, undefined, undefined, this.ctx);
    return { text: result.content[0].text, details: result.details };
  }
}

const state = (lane: any) =>
  `delivery=${lane.lifecycle?.delivery} aborted=${lane.abortController?.signal.aborted} registered=${subagentsTest.runningSubagents.get(lane.id) === lane}`;

describe("TASK-470 terminal shutdown reaps only the shutting-down session's lanes", () => {
  it("AC1 sibling shutdown: session A's terminal shutdown leaves session B's running lane untouched", async () => {
    environment();
    const a = new Session("01a0dc61-aaaa-72e2-b2fb-8e6f23ceb14b");
    const b = new Session("01a0dc61-bbbb-72e2-b2fb-8e6c0baa9ee8");
    const laneA = await a.spawn("lane-a");
    const laneB = await b.spawn("lane-b");
    a.shutdown("quit");
    const size = subagentsTest.runningSubagents.size;
    const [deliveryB, abortedB, registeredB] = [laneB.lifecycle.delivery, laneB.abortController.signal.aborted, subagentsTest.runningSubagents.get(laneB.id)];
    console.log(`   [sibling] map.size=${size} A: ${state(laneA)} | B: ${state(laneB)}`);
    // Snapshot taken above; interrupting B's lane now cannot change what shutdown did.
    const hit = await b.interrupt("lane-b");
    console.log(`   [sibling] B interrupt lane-b -> ${hit.text}`);
    // A's own lane is reaped exactly as before.
    assert.equal(laneA.lifecycle.delivery, "suppressed");
    assert.equal(laneA.abortController.signal.aborted, true);
    assert.equal(subagentsTest.runningSubagents.has(laneA.id), false);
    // B's lane survives: registered, not aborted, delivery still pending.
    assert.equal(size, 1, "sibling session's lane was cleared from the registry");
    assert.equal(registeredB, laneB);
    assert.equal(abortedB, false, "sibling session's lane was aborted");
    assert.equal(deliveryB, "pending", "sibling session's delivery was suppressed");
    assert.doesNotMatch(hit.text, /No running subagent named/);
    assert.equal(hit.details.id, laneB.id);
  });

  it("AC3 reload preserves: a reload shutdown keeps every running lane, own and sibling", async () => {
    environment();
    const a = new Session("01a0dc61-aaaa-72e2-b2fb-8e6f23ceb14b");
    const b = new Session("01a0dc61-bbbb-72e2-b2fb-8e6c0baa9ee8");
    const laneA = await a.spawn("lane-a");
    const laneB = await b.spawn("lane-b");
    a.shutdown("reload");
    console.log(`   [reload] map.size=${subagentsTest.runningSubagents.size} A: ${state(laneA)} | B: ${state(laneB)}`);
    for (const lane of [laneA, laneB]) {
      assert.equal(subagentsTest.runningSubagents.get(lane.id), lane);
      assert.equal(lane.abortController.signal.aborted, false);
      assert.equal(lane.lifecycle.delivery, "pending");
    }
    assert.equal(subagentsTest.runningSubagents.size, 2);
  });

  it("AC3 own lanes cleaned: terminal shutdown aborts, suppresses and unregisters every own lane, leaking none", async () => {
    environment();
    const a = new Session("01a0dc61-aaaa-72e2-b2fb-8e6f23ceb14b");
    const lanes = [await a.spawn("one"), await a.spawn("two"), await a.spawn("two")];
    a.shutdown("quit");
    console.log(`   [own] map.size=${subagentsTest.runningSubagents.size} ${lanes.map(state).join(" | ")}`);
    for (const lane of lanes) {
      assert.equal(lane.abortController.signal.aborted, true);
      assert.equal(lane.lifecycle.delivery, "suppressed");
    }
    assert.equal(subagentsTest.runningSubagents.size, 0, "own lane leaked after terminal shutdown");
  });
});
