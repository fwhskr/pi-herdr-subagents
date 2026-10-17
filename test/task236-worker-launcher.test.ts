import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import subagentsExtension, { __test__ as subagentsTest } from "../pi-extension/subagents/index.ts";
import { __herdrTest__ } from "../pi-extension/subagents/herdr.ts";
import { PiHarnessDriver, type SubagentLaunchContext } from "../pi-extension/subagents/harness/index.ts";

// TASK-236: a Herdr pane PATH lacks <agent dir>/bin, so a bare `pi` runs the stock
// install instead of the installed wrapper. Both worker launch routes (first
// spawn through the harness driver, and exact-session resume) must use the
// installed wrapper when it exists and keep launching bare `pi` when it does not.
//
// Run: timeout 60 node --test test/task236-worker-launcher.test.ts

const BARE_PATH = "/usr/bin:/bin";
const ENV_NAMES = [
  "HOME", "PATH", "PI_CODING_AGENT_DIR", "HERDR_ENV", "HERDR_PANE_ID", "HERDR_TAB_ID",
  "HERDR_WORKSPACE_ID", "HERDR_LOG", "PI_SUBAGENT_ID", "PI_DENY_TOOLS", "PI_SUBAGENT_SHELL_READY_DELAY_MS",
] as const;
const originalEnv = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
const roots = new Set<string>();

beforeEach(() => {
  delete process.env.PI_SUBAGENT_ID;
  delete process.env.PI_DENY_TOOLS;
});
afterEach(() => {
  for (const name of ENV_NAMES) {
    if (originalEnv[name] == null) delete process.env[name];
    else process.env[name] = originalEnv[name];
  }
  subagentsTest.runningSubagents.clear();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

function scratch(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.add(root);
  return root;
}

/** Executable stub that records which launcher ran, with its argv and cwd. */
function writeStub(path: string, label: string, record: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n{ echo "launcher=${label}"; echo "cwd=$PWD"; for a in "$@"; do echo "arg=$a"; done; } > ${JSON.stringify(record)}\n`, "utf8");
  chmodSync(path, 0o755);
}

function runBare(script: string, cwd: string, extraEnv: Record<string, string> = {}) {
  return spawnSync("bash", [script], {
    cwd, encoding: "utf8", timeout: 10_000,
    env: { PATH: BARE_PATH, HOME: "/nonexistent-task236-home", ...extraEnv },
  });
}

function launchContext(cwd: string, sessionFile: string, subagentsDir: string): SubagentLaunchContext {
  return {
    params: { id: "fixture1", name: "worker", task: "fixture task" },
    runtimePlan: { provider: "fixture", modelId: "m", model: "fixture/m", thinking: "medium", modelSource: "request", thinkingSource: "request" },
    effectiveModel: "fixture/m",
    effectiveThinking: "medium",
    parentThinking: "medium",
    surface: "pane-1",
    artifactDir: join(cwd, "artifacts"),
    sessionDir: join(cwd, "sessions"),
    subagentSessionFile: sessionFile,
    effectiveCwd: cwd,
    effectiveAutoExit: true,
    effectiveInteractive: false,
    inheritsConversationContext: true,
    taskDelivery: "direct",
    subagentsDir,
    shellQuote: (s: string) => `'${s.replace(/'/g, "'\\''")}'`,
  } as SubagentLaunchContext;
}

function buildSpawn(root: string): { command: string; cwd: string; script: string } {
  const cwd = join(root, "project");
  mkdirSync(cwd, { recursive: true });
  const built = new PiHarnessDriver().buildCommand(launchContext(cwd, join(root, "child.jsonl"), join(root, "sub")));
  const script = join(root, "spawn.sh");
  writeFileSync(script, `#!/bin/bash\n${built.command}\n`, "utf8");
  return { command: built.command, cwd, script };
}

function parseRecord(path: string): { launcher: string; args: string[]; cwd: string } {
  const lines = readFileSync(path, "utf8").split("\n");
  return {
    launcher: lines.find((l) => l.startsWith("launcher="))!.slice(9),
    cwd: lines.find((l) => l.startsWith("cwd="))!.slice(4),
    args: lines.filter((l) => l.startsWith("arg=")).map((l) => l.slice(4)),
  };
}

describe("TASK-236 spawn route (harness driver) under a bare PATH", () => {
  it("launches the installed wrapper when <agent dir>/bin/pi exists", () => {
    const root = scratch("task236-spawn-wrap-");
    const record = join(root, "record");
    const agent = join(root, "agent");
    writeStub(join(agent, "bin", "pi"), "wrapper", record);
    process.env.PI_CODING_AGENT_DIR = agent;
    const { script, cwd } = buildSpawn(root);
    const result = runBare(script, cwd, { PI_CODING_AGENT_DIR: agent });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(existsSync(record), "wrapper was not launched");
    const got = parseRecord(record);
    assert.equal(got.launcher, "wrapper");
    assert.equal(got.cwd, cwd);
    assert.deepEqual(got.args.slice(0, 2), ["--session", join(root, "child.jsonl")]);
    assert.ok(got.args.includes("--model") && got.args.includes("fixture/m"));
    assert.equal(got.args.at(-1), "fixture task");
  });

  it("derives the agent dir from HOME/.pi/agent when PI_CODING_AGENT_DIR is unset", () => {
    const root = scratch("task236-spawn-home-");
    const record = join(root, "record");
    writeStub(join(root, "home", ".pi", "agent", "bin", "pi"), "wrapper", record);
    delete process.env.PI_CODING_AGENT_DIR;
    process.env.HOME = join(root, "home");
    const { script, cwd } = buildSpawn(root);
    const result = runBare(script, cwd);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(existsSync(record), "wrapper was not launched");
    assert.equal(parseRecord(record).launcher, "wrapper");
  });

  it("keeps launching bare `pi` when no wrapper exists", () => {
    const root = scratch("task236-spawn-stock-");
    const record = join(root, "record");
    const agent = join(root, "agent");
    mkdirSync(join(agent, "bin"), { recursive: true }); // bin dir without a wrapper
    process.env.PI_CODING_AGENT_DIR = agent;
    process.env.HOME = join(root, "emptyhome");
    const { command, script, cwd } = buildSpawn(root);
    assert.match(command, /(^|[ &;])pi --session /, command);
    writeStub(join(root, "stockbin", "pi"), "stock", record);
    const result = runBare(script, cwd, { PATH: `${join(root, "stockbin")}:${BARE_PATH}`, PI_CODING_AGENT_DIR: agent });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(parseRecord(record).launcher, "stock");
  });

  it("ignores a wrapper outside the configured agent dir", () => {
    const root = scratch("task236-spawn-decoy-");
    writeStub(join(root, "home", ".pi", "agent", "bin", "pi"), "decoy", join(root, "record"));
    mkdirSync(join(root, "agent"), { recursive: true });
    process.env.PI_CODING_AGENT_DIR = join(root, "agent");
    process.env.HOME = join(root, "home");
    const { command } = buildSpawn(root);
    assert.ok(!command.includes(`${root}/home`), command);
    assert.match(command, /(^|[ &;])pi --session /, command);
  });
});

function fakeHerdr(root: string): void {
  const bin = join(root, "herdrbin");
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
    print(json.dumps({"result": {"pane": {"pane_id": args[2], "agent_status": "done"}}}))
elif args[:2] == ["pane", "read"]:
    print("")
`, "utf8");
  chmodSync(join(bin, "herdr"), 0o755);
  process.env.HERDR_LOG = join(root, "herdr.log");
  writeFileSync(process.env.HERDR_LOG, "", "utf8");
  process.env.PATH = `${bin}:${originalEnv.PATH ?? BARE_PATH}`;
}

function createApi(parentSession: string, entries: object[]) {
  const handlers = new Map<string, Function[]>();
  const tools: any[] = [];
  const append = (entry: object) => {
    entries.push(entry);
    writeFileSync(parentSession, entries.map((value) => JSON.stringify(value)).join("\n") + "\n", "utf8");
  };
  const api = {
    on(event: string, handler: Function) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
    registerTool(tool: any) { tools.push(tool); },
    registerCommand() {}, registerMessageRenderer() {}, registerShortcut() {},
    getAllTools() { return []; }, getThinkingLevel() { return "medium"; }, sendUserMessage() {},
    sendMessage(message: any) {
      append({ type: "custom_message", id: `custom-${entries.length}`, customType: message.customType, content: message.content, display: message.display, details: message.details });
    },
    appendEntry(type: string, data: object) { append({ type: "custom", id: `entry-${entries.length}`, customType: type, data }); },
  } as any;
  return {
    api, handlers, tools,
    ctx: {
      cwd: process.cwd(), hasUI: true, mode: "tui",
      model: { provider: "fake", id: "parent" },
      modelRegistry: { find: () => ({ provider: "fake", id: "parent", reasoning: true }), getAvailable: () => [], hasConfiguredAuth: () => true },
      sessionManager: { getSessionFile: () => parentSession, getSessionId: () => "parent-id", getSessionDir: () => join(parentSession, "..") },
      ui: { notify() {}, setWidget() {} },
    } as any,
  };
}

async function launchResume(root: string, t: any): Promise<{ script: string; cwd: string; child: string }> {
  fakeHerdr(root);
  process.env.HERDR_ENV = "1";
  process.env.HERDR_PANE_ID = "parent-pane";
  process.env.HERDR_TAB_ID = "parent-tab";
  process.env.HERDR_WORKSPACE_ID = "parent-workspace";
  process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "0";
  __herdrTest__.clearCommandAvailability();
  const parent = join(root, "parent.jsonl");
  const entries: object[] = [{ type: "session", version: 3, id: "parent-id", timestamp: "2026-10-07T23:22:00.000Z", cwd: root }];
  writeFileSync(parent, JSON.stringify(entries[0]) + "\n", "utf8");
  const built = createApi(parent, entries);
  built.ctx.cwd = root;
  subagentsExtension(built.api);
  built.handlers.get("session_start")?.[0]({}, built.ctx);
  t.after(() => built.handlers.get("session_shutdown")?.[0]({ reason: "exit" }, built.ctx));
  const tool = built.tools.find((candidate) => candidate.name === "subagent_resume");
  const cwd = join(root, "project");
  mkdirSync(cwd, { recursive: true });
  const child = join(root, "child.jsonl");
  writeFileSync(child, JSON.stringify({ type: "session", version: 3, id: "child-id", timestamp: "2026-10-07T23:22:00.000Z", cwd }) + "\n", "utf8");
  const result = await tool.execute("task236", { name: "worker", sessionPath: child, message: "continue fixture", autoExit: true }, undefined, undefined, built.ctx);
  assert.equal(result.details.status, "started", JSON.stringify(result.details));
  writeFileSync(`${child}.exit`, JSON.stringify({ type: "done", runId: result.details.id }));
  const deadline = performance.now() + 5_000;
  const delivered = () => entries.some((entry: any) => entry.customType === "subagent_result" && entry.details?.sessionFile === child);
  while (!delivered() && performance.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  return { script: result.details.launchScriptFile, cwd, child };
}

describe("TASK-236 resume route (subagent_resume) under a bare PATH", () => {
  it("launches the installed wrapper when <agent dir>/bin/pi exists", { timeout: 20_000 }, async (t) => {
    const root = scratch("task236-resume-wrap-");
    const record = join(root, "record");
    const agent = join(root, "agent");
    writeStub(join(agent, "bin", "pi"), "wrapper", record);
    process.env.PI_CODING_AGENT_DIR = agent;
    const { script, cwd, child } = await launchResume(root, t);
    const result = runBare(script, cwd, { PI_CODING_AGENT_DIR: agent });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(existsSync(record), "wrapper was not launched");
    const got = parseRecord(record);
    assert.equal(got.launcher, "wrapper");
    assert.deepEqual(got.args.slice(0, 2), ["--session", child]);
  });

  it("keeps launching bare `pi` when no wrapper exists", { timeout: 20_000 }, async (t) => {
    const root = scratch("task236-resume-stock-");
    const record = join(root, "record");
    const agent = join(root, "agent");
    mkdirSync(agent, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agent;
    process.env.HOME = join(root, "emptyhome");
    const { script, cwd, child } = await launchResume(root, t);
    assert.match(readFileSync(script, "utf8"), /(^|[ &;])pi --session /);
    writeStub(join(root, "stockbin", "pi"), "stock", record);
    const result = runBare(script, cwd, { PATH: `${join(root, "stockbin")}:${BARE_PATH}`, PI_CODING_AGENT_DIR: agent });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(parseRecord(record).launcher, "stock");
    assert.deepEqual(parseRecord(record).args.slice(0, 2), ["--session", child]);
  });
});
