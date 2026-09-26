import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import subagentsExtension, { __test__ as subagentsTest } from "../pi-extension/subagents/index.ts";
import { __herdrTest__ } from "../pi-extension/subagents/herdr.ts";

// TASK-469: the running-subagent registry is one Map per pi process
// (index.ts:1176), the widget rendered every lane in it (:1420) and
// interrupt-by-name matched every lane in it (:1529). Two sessions in one
// process therefore saw each other's lanes, and `subagent_interrupt {name:"echo"}`
// from 6cca answered "Ambiguous ... echo [e3161175], echo [8e332cdf]" where
// e3161175 belonged to sibling 6cc5 (2026-09-26T06:40:36Z). Two real extension
// loads share the real process-global runtime; fake herdr, real subagent tools.
//
// Run: timeout 90 node --test --test-name-pattern='<selector>' test/task469-session-lane-scope.test.ts
// Selectors: "AC1 sibling widget", "AC1 sibling interrupt", "AC3 single session"

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
  const root = mkdtempSync(join(tmpdir(), "task469-"));
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
  widget: any;
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
      ui: {
        notify() {}, setStatus() {},
        setWidget: (key: string, factory: any) => { if (key === "subagent-status") this.widget = factory; },
      },
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

  /** Spawn a lane; returns its running id. */
  async spawn(name: string): Promise<string> {
    const tool = this.tools.find((candidate) => candidate.name === "subagent");
    const before = new Set(subagentsTest.runningSubagents.keys());
    const result = await tool.execute(name, { name, agent: "worker", task: `task for ${name}`, interactive: false }, undefined, undefined, this.ctx);
    assert.match(result.content[0].text, /launched and is now running/);
    const added = Array.from(subagentsTest.runningSubagents.keys()).filter((id) => !before.has(id));
    assert.equal(added.length, 1);
    return added[0];
  }

  /** The lane rows this session's own UI widget shows right now. */
  widgetRows(): string[] {
    if (!this.widget) return [];
    const lines: string[] = this.widget(undefined, undefined).render(120);
    // eslint-disable-next-line no-control-regex
    return lines.slice(1, -1).map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").replace(/^│\s*[\d:]+\s+/, "").replace(/\s{2,}.*$/, "").trim());
  }

  async interrupt(params: { name?: string; id?: string }): Promise<{ text: string; details: any }> {
    const tool = this.tools.find((candidate) => candidate.name === "subagent_interrupt");
    const result = await tool.execute("interrupt", params, undefined, undefined, this.ctx);
    return { text: result.content[0].text, details: result.details };
  }
}

async function until(predicate: () => boolean, ms = 4_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
}

describe("TASK-469 session-scoped lane list", () => {
  it("AC1 sibling widget: each session's widget lists its own lanes only", async () => {
    environment();
    const s6cca = new Session("01a0dc61-6cca-72e2-b2fb-8e6f23ceb14b");
    const s6cc5 = new Session("01a0dc61-6cc5-72e2-b2fb-8e6c0baa9ee8"); // started LAST
    await s6cca.spawn("echo");
    await s6cc5.spawn("echo");
    await s6cca.spawn("small");
    await until(() => s6cca.widgetRows().length > 0 && s6cc5.widgetRows().length > 0, 2_500);
    console.log(`   [widget] 6cca=${JSON.stringify(s6cca.widgetRows())} 6cc5=${JSON.stringify(s6cc5.widgetRows())}`);
    assert.deepEqual(s6cc5.widgetRows(), ["echo (worker)"], "6cc5's widget shows sibling 6cca's lanes");
    assert.deepEqual(s6cca.widgetRows(), ["echo (worker)", "small (worker)"], "6cca's own widget does not show its own lanes");
  });

  it("AC1 sibling interrupt: interrupt-by-name resolves to the caller's own lane, never ambiguous with a sibling's", async () => {
    environment();
    const s6cca = new Session("01a0dc61-6cca-72e2-b2fb-8e6f23ceb14b");
    const s6cc5 = new Session("01a0dc61-6cc5-72e2-b2fb-8e6c0baa9ee8");
    const own = await s6cca.spawn("echo");
    const sibling = await s6cc5.spawn("echo");
    const result = await s6cca.interrupt({ name: "echo" });
    console.log(`   [interrupt] own=${own} sibling=${sibling} -> ${result.text}`);
    assert.doesNotMatch(result.text, /Ambiguous/, "interrupt-by-name matched the sibling session's lane");
    assert.equal(result.details.id, own, "interrupt-by-name must target the caller's own lane");
    assert.equal((subagentsTest.runningSubagents.get(own) as any).lifecycle.turn.kind, "interrupted");
    assert.notEqual((subagentsTest.runningSubagents.get(sibling) as any).lifecycle.turn.kind, "interrupted", "the sibling's lane must not be interrupted");
    // The sibling cannot reach 6cca's remaining lanes by name either.
    const miss = await s6cc5.interrupt({ name: "small" });
    assert.match(miss.text, /No running subagent named "small"/);
  });

  it("AC3 single session: own lanes all listed once, interrupt-by-name targets own lane, own duplicates stay ambiguous", async () => {
    environment();
    const only = new Session("ac3-only-session");
    const alpha = await only.spawn("alpha");
    const beta = await only.spawn("beta");
    const gamma1 = await only.spawn("gamma");
    const gamma2 = await only.spawn("gamma");
    await until(() => only.widgetRows().length === 4, 2_500);
    console.log(`   [control] widget=${JSON.stringify(only.widgetRows())}`);
    assert.deepEqual(only.widgetRows(), ["alpha (worker)", "beta (worker)", "gamma (worker)", "gamma (worker)"]);
    const hitBeta = await only.interrupt({ name: "beta" });
    assert.equal(hitBeta.details.id, beta);
    const ambiguous = await only.interrupt({ name: "gamma" });
    assert.equal(ambiguous.text, `Ambiguous subagent name "gamma". Matches: gamma [${gamma1}], gamma [${gamma2}]`);
    const byId = await only.interrupt({ id: alpha });
    assert.equal(byId.details.id, alpha);
  });
});
