import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import subagentsExtension, { __test__ as subagentsTest } from "../pi-extension/subagents/index.ts";
import subagentDoneExtension from "../pi-extension/subagents/subagent-done.ts";
import { __herdrTest__ } from "../pi-extension/subagents/herdr.ts";

// TASK-450 core: a RESUMED worker must carry the tools allowlist recorded at
// spawn time, and its close tools (subagent_done, caller_ping) must survive the
// lazy-tools session_start deferral. Without both, the resumed worker gets
// "Tool subagent_done not found", has no close path, and sits idle forever.

const ENV_NAMES = [
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
  "PI_SUBAGENT_AUTO_EXIT",
  "PI_SUBAGENT_AUTO_EXIT_REARM",
  "PI_SUBAGENT_RESUME_INPUT",
  "PI_SUBAGENT_SESSION",
  "PI_SUBAGENT_ACTIVITY_FILE",
  "PI_SUBAGENT_PENDING_CHILD_POLL_MS",
] as const;
const originalEnv = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
const tempRoots = new Set<string>();

function restoreEnv(): void {
  for (const name of ENV_NAMES) {
    const value = originalEnv[name];
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

beforeEach(() => {
  delete process.env.PI_SUBAGENT_ID;
  delete process.env.PI_DENY_TOOLS;
});

function writeJsonl(path: string, entries: object[]): void {
  writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
}

function header(id: string, cwd: string): object {
  return { type: "session", version: 3, id, timestamp: "2026-09-26T00:00:00.000Z", cwd };
}

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.add(root);
  return root;
}

function fakeHerdr(root: string): string {
  const bin = join(root, "bin");
  const command = join(bin, "herdr");
  const log = join(root, "herdr.log");
  mkdirSync(bin, { recursive: true });
  writeFileSync(command, `#!/usr/bin/env python3
import json, os, re, shlex, sys
args = sys.argv[1:]
with open(os.environ["HERDR_LOG"], "a", encoding="utf-8") as f:
    f.write(" ".join(args) + "\\n")
if args[:2] == ["pane", "list"]:
    print(json.dumps({"result": {"type": "pane_list", "panes": json.loads(os.environ.get("HERDR_PANES", "[]"))}}))
elif args[:2] == ["pane", "current"]:
    print(json.dumps({"result": {"pane": {"pane_id": "parent-pane", "tab_id": "parent-tab", "workspace_id": "parent-workspace"}}}))
elif args[:2] == ["tab", "create"]:
    print(json.dumps({"result": {"root_pane": {"pane_id": "new-pane-" + str(os.getpid())}}}))
elif args[:2] == ["pane", "get"]:
    print(json.dumps({"result": {"pane": {"pane_id": args[2], "agent_status": "done"}}}))
elif args[:2] in (["pane", "rename"], ["pane", "report-metadata"], ["pane", "close"]):
    pass
elif args[:2] == ["pane", "read"]:
    print("")
elif args[:2] == ["pane", "run"]:
    script = args[3] if len(args) > 3 else ""
    try:
        script_path = shlex.split(script)[1]
        text = open(script_path, encoding="utf-8").read()
        match = re.search(r"PI_SUBAGENT_SESSION='([^']+)'", text)
        if not match:
            match = re.search(r"--session '([^']+)'", text)
        if match:
            session = match.group(1)
            os.makedirs(os.path.dirname(session), exist_ok=True)
            if not os.path.exists(session):
                with open(session, "w", encoding="utf-8") as f:
                    json.dump({"type": "session", "version": 3, "id": "fake-child", "cwd": os.path.dirname(session)}, f)
                    f.write("\\n")
            with open(session + ".exit", "w", encoding="utf-8") as f:
                json.dump({"type": "done"}, f)
    except Exception as error:
        with open(os.environ["HERDR_LOG"], "a", encoding="utf-8") as f:
            f.write("fake-error:" + repr(error) + "\\n")
`, "utf8");
  chmodSync(command, 0o755);
  writeFileSync(log, "", "utf8");
  process.env.HERDR_LOG = log;
  process.env.PATH = `${bin}:${originalEnv.PATH ?? ""}`;
  return log;
}

function createApi(parentSession: string, entries: object[]) {
  const handlers = new Map<string, Function[]>();
  const tools: any[] = [];
  const messages: any[] = [];
  const notifications: Array<{ message: string; type?: string }> = [];
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
    notifications,
    ctx: {
      cwd: process.cwd(),
      hasUI: true,
      mode: "tui",
      model: { provider: "fake", id: "parent" },
      modelRegistry: {
        find: () => ({ provider: "fake", id: "parent", reasoning: true }),
        getAvailable: () => [],
        hasConfiguredAuth: () => true,
      },
      sessionManager: {
        getSessionFile: () => parentSession,
        getSessionId: () => "parent-id",
        getSessionDir: () => process.cwd(),
      },
      ui: {
        notify(message: string, type?: string) { notifications.push({ message, type }); },
        setWidget() {},
      },
    } as any,
  };
}

/** Resume a child session with a given spawn sidecar; return the launch script. */
async function resumeWithSidecar(sidecar: object): Promise<{ root: string; script: string }> {
  const root = tempRoot("task450-resume-");
  const parent = join(root, "parent.jsonl");
  const entries = [header("parent-id", root)];
  writeJsonl(parent, entries);
  const child = join(root, "child.jsonl");
  writeJsonl(child, [header("child-id", root)]);
  writeFileSync(`${child}.spawn.json`, JSON.stringify({
    allowance: 0,
    parentSessionFile: parent,
    parentSessionId: "parent-id",
    childSessionFile: child,
    name: "worker",
    agent: "task450-no-such-agent",
    task: "resume me",
    launchedAt: "2026-09-26T00:00:00.000Z",
    ...sidecar,
  }), "utf8");

  fakeHerdr(root);
  process.env.HERDR_ENV = "1";
  process.env.HERDR_PANE_ID = "parent-pane";
  process.env.HERDR_TAB_ID = "parent-tab";
  process.env.HERDR_WORKSPACE_ID = "parent-workspace";
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "0";
  __herdrTest__.clearCommandAvailability();

  const built = createApi(parent, entries);
  built.ctx.cwd = root;
  built.ctx.sessionManager.getSessionDir = () => root;
  subagentsExtension(built.api);
  const start = built.handlers.get("session_start")?.[0];
  assert.ok(start);
  start({}, built.ctx);

  const tool = built.tools.find((candidate) => candidate.name === "subagent_resume");
  assert.ok(tool, "subagent_resume tool registered");
  const result = await tool.execute(
    "task450",
    { name: "worker", sessionPath: child, message: "go", autoExit: true },
    undefined,
    undefined,
    built.ctx,
  );
  assert.equal(result.details.status, "started", JSON.stringify(result.details));

  const scripts = readdirSync(join(root, "artifacts", "parent-id", "subagent-scripts"));
  const resumeScript = scripts.find((file) =>
    readFileSync(join(root, "artifacts", "parent-id", "subagent-scripts", file), "utf8")
      .includes("Subagent resume script"),
  );
  assert.ok(resumeScript, `resume launch script written (found: ${scripts.join(", ")})`);
  const script = readFileSync(join(root, "artifacts", "parent-id", "subagent-scripts", resumeScript), "utf8");

  const shutdown = built.handlers.get("session_shutdown")?.[0];
  shutdown?.({ reason: "exit" }, built.ctx);
  return { root, script };
}

function toolsFlag(script: string): string | null {
  const match = script.match(/--tools\s+'([^']*)'/) ?? script.match(/--tools\s+(\S+)/);
  return match ? match[1] : null;
}

describe("TASK-450 resume carries the recorded tools allowlist", () => {
  it("passes the spawn-recorded allowlist (with control tools) to the resumed pi", { timeout: 10_000 }, async () => {
    const { script } = await resumeWithSidecar({ tools: "read,write" });
    const allowlist = toolsFlag(script);
    assert.ok(allowlist, `resume command must pass --tools, script:\n${script.slice(0, 600)}`);
    const tools = new Set(allowlist.split(",").map((tool) => tool.trim()));
    for (const expected of ["read", "write", "caller_ping", "subagent_done"]) {
      assert.ok(tools.has(expected), `allowlist missing ${expected}: ${allowlist}`);
    }
  });

  it("passes no --tools when the spawn recorded no restriction (spawn parity)", { timeout: 10_000 }, async () => {
    const { script } = await resumeWithSidecar({ tools: null });
    assert.equal(toolsFlag(script), null, `spawn passed no allowlist, resume must not invent one:\n${script.slice(0, 600)}`);
  });

  it("resolveResumeToolAllowlist: recorded tools win, agent defaults only when unrecorded", () => {
    const resolve = (subagentsTest as any).resolveResumeToolAllowlist;
    assert.equal(typeof resolve, "function", "resolveResumeToolAllowlist must be exported via __test__");

    const recorded = resolve("read,write", "agent-defaults");
    assert.deepEqual(
      recorded.split(",").sort(),
      ["caller_ping", "read", "subagent_done", "write"],
      "recorded spawn allowlist must be carried, control tools included",
    );

    assert.equal(resolve(null, "read,bash"), null, "recorded null = spawn passed no --tools, authoritative");

    const fallback = resolve(undefined, "read,web_search");
    assert.ok(fallback, "unrecorded metadata falls back to the agent's defaults");
    assert.deepEqual(
      fallback.split(",").sort(),
      ["caller_ping", "read", "subagent_done", "web_search"],
      "agent-default fallback must include the control tools",
    );

    assert.equal(resolve(undefined, undefined), null, "nothing recorded and no agent defaults ⇒ no restriction");
    assert.equal(resolve("  ", undefined), null, "blank recorded value ⇒ no restriction");
  });
});

describe("TASK-450 control tools survive the lazy-tools session_start deferral", () => {
  const EAGER = ["read", "bash", "edit", "write", "todo", "lazy_load_tools"];

  function bootWorker() {
    for (const name of ENV_NAMES) delete process.env[name];
    process.env.PI_SUBAGENT_AUTO_EXIT = "1";
    const sessionFile = join(tempRoot("task450-worker-"), "worker.jsonl");
    writeFileSync(sessionFile, "session header\n");
    process.env.PI_SUBAGENT_SESSION = sessionFile;

    const handlers = new Map<string, Function[]>();
    const registered: any[] = [];
    let active: string[] = [];
    const pi = {
      on(event: string, handler: Function) {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
      registerTool(tool: any) { registered.push(tool); },
      registerCommand() {},
      registerMessageRenderer() {},
      registerShortcut() {},
      sendUserMessage() {},
      sendMessage() {},
      getAllTools() { return registered; },
      getActiveTools() { return active; },
      setActiveTools(names: string[]) { active = [...names]; },
    } as any;

    // lazy-tools is a user extension: its session_start handler runs before the
    // package/-e extension loads, strips the active loadout to the eager set,
    // and its before_agent_start re-runs the same strip.
    const lazyStrip = () => { active = EAGER.filter((name) => registered.some((tool) => tool.name === name)); };
    handlers.set("session_start", [lazyStrip]);

    subagentDoneExtension(pi);
    const ctx: any = {
      cwd: tempRoot("task450-cwd-"),
      sessionManager: { getEntries: () => [] },
      ui: { notify() {}, setWidget() {} },
      shutdown() {},
    };
    const fire = (event: string) => {
      for (const handler of handlers.get(event) ?? []) handler({}, ctx);
    };
    return {
      fire,
      getActive: () => active,
      seeded(): void { active = [...EAGER]; },
    };
  }

  it("re-asserts subagent_done + caller_ping at session_start and before_agent_start", () => {
    const worker = bootWorker();
    worker.seeded();
    worker.fire("session_start");
    let active = new Set(worker.getActive());
    for (const tool of ["subagent_done", "caller_ping"]) {
      assert.ok(active.has(tool), `session_start must re-assert ${tool} after the lazy deferral (active: ${[...active].join(", ")})`);
    }

    // Worst case: the deferral runs AFTER the extension's session_start handler.
    worker.seeded();
    worker.fire("before_agent_start");
    active = new Set(worker.getActive());
    for (const tool of ["subagent_done", "caller_ping"]) {
      assert.ok(active.has(tool), `before_agent_start must re-assert ${tool} (active: ${[...active].join(", ")})`);
    }
  });
});
