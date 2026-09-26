import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import subagentsExtension, { __test__ as subagentsTest } from "../pi-extension/subagents/index.ts";
import { __herdrTest__ } from "../pi-extension/subagents/herdr.ts";

// TASK-454: a subagent call that omits cwd must launch in the parent session
// cwd. Before the fix, resolveSubagentPaths returned effectiveCwd null, the pi
// driver passed it to resolveSpawnTrustFlag, and spawn-trust.ts canonicalizePath
// threw `The "paths[0]" argument must be of type string. Received null`.

const ENV_NAMES = [
  "HERDR_ENV", "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID", "HERDR_LOG", "PATH",
  "PI_CODING_AGENT_DIR", "PI_SUBAGENT_ID", "PI_SUBAGENT_AGENT", "PI_SUBAGENT_SHELL_READY_DELAY_MS",
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

/** Fake herdr: creates panes, accepts `pane run` and marks the child done. */
function fakeHerdr(root: string): void {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const command = join(bin, "herdr");
  writeFileSync(command, `#!/usr/bin/env python3
import json, os, re, shlex, sys
args = sys.argv[1:]
with open(os.environ["HERDR_LOG"], "a") as f:
    f.write(" ".join(args) + "\\n")
if args[:2] == ["pane", "list"]:
    print(json.dumps({"result": {"type": "pane_list", "panes": []}}))
elif args[:2] == ["pane", "current"]:
    print(json.dumps({"result": {"pane": {"pane_id": "parent-pane", "tab_id": "parent-tab", "workspace_id": "parent-workspace"}}}))
elif args[:2] == ["tab", "create"]:
    print(json.dumps({"result": {"root_pane": {"pane_id": "new-pane-" + str(os.getpid())}}}))
elif args[:2] == ["pane", "get"]:
    print(json.dumps({"result": {"pane": {"pane_id": args[2], "agent_status": "done"}}}))
elif args[:2] == ["pane", "run"]:
    text = open(shlex.split(args[3])[1]).read()
    m = re.search(r"PI_SUBAGENT_SESSION='([^']+)'", text)
    if m:
        s = m.group(1)
        os.makedirs(os.path.dirname(s), exist_ok=True)
        open(s, "a").close()
        with open(s + ".exit", "w") as f:
            json.dump({"type": "done"}, f)
`, "utf8");
  chmodSync(command, 0o755);
  process.env.HERDR_LOG = join(root, "herdr.log");
  writeFileSync(process.env.HERDR_LOG, "", "utf8");
  process.env.PATH = `${bin}:${originalEnv.PATH ?? ""}`;
}

/** Spawn through the real `subagent` tool; return the written launch script. */
async function spawn(params: Record<string, unknown>, profileCwd?: string): Promise<{ root: string; script: string }> {
  const root = mkdtempSync(join(tmpdir(), "task454-"));
  roots.push(root);
  const agentDir = join(root, "agent");
  mkdirSync(join(agentDir, "agents"), { recursive: true });
  writeFileSync(
    join(agentDir, "agents", "task454worker.md"),
    `---\nname: task454worker\n${profileCwd ? `cwd: ${profileCwd}\n` : ""}---\nYou are a test worker.\n`,
    "utf8",
  );
  // A trust store exists on every real install; its presence alone reached the throw.
  writeFileSync(join(agentDir, "trust.json"), "{}", "utf8");
  const parent = join(root, "parent.jsonl");
  writeFileSync(parent, JSON.stringify({ type: "session", version: 3, id: "parent-id", cwd: root }) + "\n", "utf8");

  fakeHerdr(root);
  Object.assign(process.env, {
    HERDR_ENV: "1",
    HERDR_PANE_ID: "parent-pane",
    HERDR_TAB_ID: "parent-tab",
    HERDR_WORKSPACE_ID: "parent-workspace",
    PI_CODING_AGENT_DIR: agentDir,
    PI_SUBAGENT_SHELL_READY_DELAY_MS: "0",
  });
  delete process.env.PI_SUBAGENT_ID;
  delete process.env.PI_SUBAGENT_AGENT;
  __herdrTest__.clearCommandAvailability();

  const handlers = new Map<string, Function>();
  const tools: any[] = [];
  const api = {
    on(event: string, handler: Function) { handlers.set(event, handler); },
    registerTool(tool: any) { tools.push(tool); },
    registerCommand() {}, registerMessageRenderer() {}, registerShortcut() {},
    getAllTools() { return []; },
    getThinkingLevel() { return "medium"; },
    sendUserMessage() {}, sendMessage() {}, appendEntry() {},
  } as any;
  const ctx = {
    cwd: root,
    hasUI: true,
    mode: "tui",
    isProjectTrusted: () => true,
    model: { provider: "fake", id: "parent" },
    modelRegistry: {
      find: () => ({ provider: "fake", id: "parent", reasoning: true }),
      getAvailable: () => [],
      hasConfiguredAuth: () => true,
    },
    sessionManager: {
      getSessionFile: () => parent,
      getSessionId: () => "parent-id",
      getSessionDir: () => root,
    },
    ui: { notify() {}, setWidget() {} },
  } as any;
  subagentsExtension(api);
  handlers.get("session_start")?.({}, ctx);
  try {
    const tool = tools.find((candidate) => candidate.name === "subagent");
    const result = await tool.execute(
      "task454",
      { name: "task454worker", agent: "task454worker", task: "noop", interactive: false, ...params },
      undefined,
      undefined,
      ctx,
    );
    assert.match(result.content[0].text, /launched and is now running/);
    const scriptsDir = join(root, "artifacts", "parent-id", "subagent-scripts");
    const [file] = readdirSync(scriptsDir);
    return { root, script: readFileSync(join(scriptsDir, file), "utf8") };
  } finally {
    handlers.get("session_shutdown")?.({ reason: "exit" }, ctx);
  }
}

describe("TASK-454 cwd-less subagent spawn", () => {
  it("cwd-less: launches in the parent session cwd instead of throwing on a null paths[0]", async () => {
    const { root, script } = await spawn({});
    assert.ok(script.includes(`cd '${root}' && `), "launch command enters the parent cwd");
  });

  it("control: an explicit cwd still resolves and launches there", async () => {
    const explicit = mkdtempSync(join(tmpdir(), "task454-explicit-"));
    roots.push(explicit);
    const { script } = await spawn({ cwd: explicit });
    assert.ok(script.includes(`cd '${explicit}' && `), "launch command enters the explicit cwd");
  });

  it("control: a profile-declared cwd wins over the parent-cwd default", async () => {
    const declared = mkdtempSync(join(tmpdir(), "task454-profile-"));
    roots.push(declared);
    const { root, script } = await spawn({}, declared);
    assert.ok(script.includes(`cd '${declared}' && `), "launch command enters the profile cwd");
    assert.ok(!script.includes(`cd '${root}' && `), "parent cwd default does not override the profile");
  });

  const guardPath = join(homedir(), ".pi", "agent", "extensions", "strict-agent-profiles.ts");
  it("control: the name != agent guard keeps its exact refusal message", { skip: !existsSync(guardPath) && "live strict-agent-profiles.ts not installed" }, async () => {
    const { default: strictAgentProfiles } = await import(guardPath);
    let handler: Function | undefined;
    strictAgentProfiles({ on(event: string, h: Function) { if (event === "tool_call") handler = h; } } as any);
    delete process.env.PI_SUBAGENT_ID;
    const verdict = handler!(
      { toolName: "subagent", input: { name: "probe-b45", agent: "small", task: "noop", interactive: false } },
      {},
    );
    assert.deepEqual(verdict, {
      block: true,
      reason: "Subagent blocked: name and agent must be the same exact approved identity.",
    });
  });
});
