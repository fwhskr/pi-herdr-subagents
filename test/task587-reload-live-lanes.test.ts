import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import subagentsExtension, { __test__ as subagentsTest } from "../pi-extension/subagents/index.ts";
import { discoverOrphanedSubagents } from "../pi-extension/subagents/orphan-discovery.ts";
import { createLifecycle } from "../pi-extension/subagents/lifecycle.ts";
import { __herdrTest__ } from "../pi-extension/subagents/herdr.ts";

const originalEnv = new Map([
  "HERDR_ENV",
  "HERDR_PANE_ID",
  "HERDR_TAB_ID",
  "HERDR_WORKSPACE_ID",
  "PATH",
  "PI_CODING_AGENT_DIR",
  "PI_SUBAGENT_ID",
  "PI_DENY_TOOLS",
  "PI_SUBAGENT_SHELL_READY_DELAY_MS",
  "HERDR_LOG",
  "HERDR_PANES",
].map((name) => [name, process.env[name]]));
const tempRoots = new Set<string>();

beforeEach(() => {
  delete process.env.PI_SUBAGENT_ID;
  delete process.env.PI_DENY_TOOLS;
  subagentsTest.runningSubagents.clear();
});

function restoreEnv(): void {
  for (const [name, value] of originalEnv) {
    if (value == null) delete process.env[name];
    else process.env[name] = value;
  }
}

afterEach(() => {
  restoreEnv();
  subagentsTest.runningSubagents.clear();
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
  tempRoots.clear();
});

function writeJsonl(path: string, entries: object[]): void {
  writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
}

function header(id: string, cwd: string, parentSession?: string): object {
  return {
    type: "session",
    version: 3,
    id,
    timestamp: "2026-09-02T00:00:00.000Z",
    cwd,
    ...(parentSession ? { parentSession } : {}),
  };
}

function userMessage(id: string, text: string): object {
  return {
    type: "message",
    id,
    message: { role: "user", content: [{ type: "text", text }] },
  };
}

function sidecar(parent: string, parentId: string, child: string, name: string, task: string): void {
  writeFileSync(`${child}.spawn.json`, JSON.stringify({
    allowance: 0,
    parentSessionFile: parent,
    parentSessionId: parentId,
    childSessionFile: child,
    name,
    agent: "worker",
    task,
    launchedAt: "2026-09-02T00:00:00.000Z",
  }), "utf8");
}

function fakeHerdr(root: string, panes: object[]): { log: string } {
  const bin = join(root, "bin");
  const command = join(bin, "herdr");
  const log = join(root, "herdr.log");
  mkdirSync(bin, { recursive: true });
  writeFileSync(command, `#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
with open(os.environ["HERDR_LOG"], "a", encoding="utf-8") as f:
    f.write(" ".join(args) + "\\n")
if args[:2] == ["pane", "list"]:
    print(json.dumps({"result": {"type": "pane_list", "panes": json.loads(os.environ.get("HERDR_PANES", "[]"))}}))
elif args[:2] == ["pane", "current"]:
    print(json.dumps({"result": {"pane": {"pane_id": "parent-pane", "tab_id": "parent-tab", "workspace_id": "parent-workspace"}}}))
elif args[:2] == ["pane", "get"]:
    print(json.dumps({"result": {"pane": {"pane_id": args[2], "agent_status": "done"}}}))
elif args[:2] in (["pane", "rename"], ["pane", "report-metadata"], ["pane", "close"]):
    pass
elif args[:2] == ["pane", "read"]:
    print("")
`, "utf8");
  chmodSync(command, 0o755);
  writeFileSync(log, "", "utf8");
  process.env.HERDR_LOG = log;
  process.env.HERDR_PANES = JSON.stringify(panes);
  process.env.PATH = `${bin}:${originalEnv.get("PATH") ?? ""}`;
  return { log };
}

function createApi(parentSession: string, entries: object[]) {
  const handlers = new Map<string, Function[]>();
  const tools: any[] = [];
  const messages: any[] = [];
  const append = (entry: object) => {
    entries.push(entry);
    writeFileSync(parentSession, entries.map((value) => JSON.stringify(value)).join("\n") + "\n", "utf8");
  };
  const api = {
    on(event: string, handler: Function) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerTool(tool: any) { tools.push(tool); },
    registerCommand() {},
    registerMessageRenderer() {},
    registerShortcut() {},
    getAllTools() { return []; },
    getThinkingLevel() { return "medium"; },
    sendUserMessage() {},
    sendMessage(message: any) {
      messages.push(message);
      append({
        type: "custom_message",
        id: `custom-${messages.length}`,
        customType: message.customType,
        content: message.content,
        display: message.display,
        details: message.details,
      });
    },
    appendEntry(type: string, data: object) {
      append({ type: "custom", id: `entry-${entries.length}`, customType: type, data });
    },
  } as any;
  return {
    api,
    handlers,
    tools,
    messages,
    ctx: {
      cwd: process.cwd(),
      hasUI: true,
      mode: "tui",
      model: { provider: "fake", id: "parent" },
      modelRegistry: {
        find: (provider: string, id: string) => ({ provider, id, reasoning: true }),
        getAvailable: () => [],
        hasConfiguredAuth: () => true,
      },
      sessionManager: {
        getSessionFile: () => parentSession,
        getSessionId: () => "parent-id",
        getSessionDir: () => process.cwd(),
      },
      ui: {
        notify() {},
        setWidget() {},
      },
    } as any,
  };
}

function contextFor(parent: string, root: string, entries: object[]) {
  const built = createApi(parent, entries);
  built.ctx.cwd = root;
  built.ctx.sessionManager.getSessionDir = () => root;
  return built;
}

/** A child lane that is still running: growing session, lineage sidecar, live pane. */
function liveLaneDisk(root: string, parent: string, name: string, task: string): string {
  const child = join(root, `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.jsonl`);
  writeJsonl(child, [header(`${name}-id`, root, parent), userMessage(`${name}-user`, "keep working")]);
  sidecar(parent, "parent-id", child, name, task);
  return child;
}

function trackLiveLane(childSession: string, id = "child-587"): void {
  const now = Date.now();
  subagentsTest.runningSubagents.set(id, {
    id,
    name: "Live worker",
    task: "live task",
    surface: "pane-587",
    startTime: now,
    sessionFile: childSession,
    interactive: false,
    owner: "parent-id",
    lifecycle: createLifecycle(now),
  } as any);
}

function setupHerdrEnv(root: string): void {
  process.env.HERDR_ENV = "1";
  process.env.HERDR_PANE_ID = "parent-pane";
  process.env.HERDR_TAB_ID = "parent-tab";
  process.env.HERDR_WORKSPACE_ID = "parent-workspace";
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "0";
  __herdrTest__.clearCommandAvailability();
}

describe("TASK-587 reload must not report live lanes as orphaned", () => {
  it("session_start after an in-process reload stays silent for a registry-tracked lane", () => {
    const root = mkdtempSync(join(tmpdir(), "task587-reload-"));
    tempRoots.add(root);
    const parent = join(root, "parent.jsonl");
    const entries: object[] = [header("parent-id", root)];
    writeJsonl(parent, entries);
    const child = liveLaneDisk(root, parent, "Live worker", "live task");
    const { log } = fakeHerdr(root, [
      { pane_id: "live-pane", agent_session: { kind: "path", value: child } },
    ]);
    void log;
    setupHerdrEnv(root);
    trackLiveLane(child);

    const built = contextFor(parent, root, entries);
    subagentsExtension(built.api);
    try {
      built.handlers.get("session_start")![0]({}, built.ctx);
      assert.equal(
        built.messages.length,
        0,
        `reload must not report a live lane, got: ${built.messages.map((message) => String(message.content)).join("\n").slice(0, 500)}`,
      );
    } finally {
      built.handlers.get("session_shutdown")?.[0]?.({ reason: "exit" }, built.ctx);
    }
  });

  it("resume input after a reload never resumes or relaunches a registry-tracked lane", { timeout: 30_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "task587-resume-"));
    tempRoots.add(root);
    const parent = join(root, "parent.jsonl");
    const entries: object[] = [header("parent-id", root)];
    writeJsonl(parent, entries);
    const child = liveLaneDisk(root, parent, "Live worker", "live task");
    const { log } = fakeHerdr(root, [
      { pane_id: "live-pane", agent_session: { kind: "path", value: child } },
    ]);
    void log;
    setupHerdrEnv(root);
    trackLiveLane(child);

    const built = contextFor(parent, root, entries);
    subagentsExtension(built.api);
    try {
      built.handlers.get("session_start")![0]({}, built.ctx);
      const input = built.handlers.get("input")?.[0];
      assert.ok(input);
      const result = await input({ text: "resume", source: "interactive" }, built.ctx);
      assert.deepEqual(result, { action: "continue" });
      assert.doesNotMatch(readFileSync(join(root, "herdr.log"), "utf8"), /pane (close|run)/);
    } finally {
      built.handlers.get("session_shutdown")?.[0]?.({ reason: "exit" }, built.ctx);
    }
  });

  it("discovery excludes registry-tracked session files but keeps genuine orphans", () => {
    const root = mkdtempSync(join(tmpdir(), "task587-discovery-"));
    tempRoots.add(root);
    const parent = join(root, "parent.jsonl");
    writeJsonl(parent, [header("parent-id", root)]);
    const live = liveLaneDisk(root, parent, "Live worker", "live task");
    const orphan = liveLaneDisk(root, parent, "Orphan worker", "orphan task");

    const found = discoverOrphanedSubagents(parent, {
      paneSessions: [
        { paneId: "live-pane", sessionPath: live },
        { paneId: "orphan-pane", sessionPath: orphan },
      ],
      liveSessionFiles: [live],
    });
    assert.deepEqual(found.map((child) => child.name), ["Orphan worker"]);
    assert.equal(found[0]?.classification, "stale-pane");
  });
});
