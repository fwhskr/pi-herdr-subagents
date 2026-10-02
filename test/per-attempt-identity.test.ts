import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";
import subagentsExtension, { __test__ as subagentsTest } from "../pi-extension/subagents/index.ts";
import { __herdrTest__ } from "../pi-extension/subagents/herdr.ts";

// TASK-3 (Sade task-681 follow-up): every completion attempt carries its own
// immutable completionId; a shared session file never reuses a completion key
// across two attempts. Drives the REAL subagent/subagent_resume tools (fake
// herdr, fake pi) and keys the captured completions with the REAL settled
// completion-key rule: explicit id first, else the delivered-payload fingerprint.
// The producer owns the id; the key function below is a local copy of that rule,
// kept in this fixture so the test never depends on the live Nova watcher.
//
// Run: timeout 60 node --test test/per-attempt-identity.test.ts
// Selectors: "success-identity", "error-identity"

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

/** Local copy of the settled completion-key rule (nova-notify-watch.ts completionKey). */
function completionKey(details: Record<string, any>): string | undefined {
  const explicit = typeof details.completionId === "string" && details.completionId.trim() ? details.completionId.trim() : undefined;
  if (explicit) return `id:${explicit}`;
  const identity = [details.sessionFile, details.sessionId, details.runId, details.taskId]
    .map((value) => typeof value === "string" && value.trim() ? value.trim() : undefined)
    .filter((value): value is string => Boolean(value));
  const fingerprint = createHash("sha256")
    .update(JSON.stringify([[identity, details.delegationId, details.task, details.agent, details.status ?? "completed"]]), "utf8")
    .digest("hex");
  return identity.length > 0 ? `delivery:${fingerprint}` : undefined;
}

/**
 * Launch through the real `subagent` / `subagent_resume` tool. When `failWatcher`,
 * the UI starts throwing inside the watcher after launch, so the detached watcher's promise chain
 * rejects and the `.catch` error completion is sent. `reuse` resumes the first
 * attempt's session file, so both attempts share one session.
 */
async function launch(kind: "spawn" | "resume", failWatcher: boolean, task: string, reuse?: { root: string; childSession: string }): Promise<{ root: string; message: Captured; childSession: string }> {
  const root = reuse?.root ?? mkdtempSync(join(tmpdir(), "per-attempt-"));
  if (!reuse) roots.push(root);
  const agentDir = join(root, "agent");
  mkdirSync(join(agentDir, "agents"), { recursive: true });
  writeFileSync(join(agentDir, "agents", "attemptworker.md"), "---\nname: attemptworker\n---\nYou are a test worker.\n", "utf8");
  const parent = join(root, "parent.jsonl");
  if (!reuse) writeFileSync(parent, JSON.stringify({ type: "session", version: 3, id: "parent-id", cwd: root }) + "\n", "utf8");
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
      setWidget() {
        if (!uiBroken || !new Error().stack!.includes("watchSubagent")) return;
        throw new Error("per-attempt injected watcher failure");
      },
      setStatus() {},
    },
  } as any;
  subagentsExtension(api);
  handlers.get("session_start")?.({}, ctx);
  // Resume registrations are keyed per session file in the live registry. Each
  // launch() re-registers a fresh extension instance sharing that registry, so
  // drop OUR OWN first attempt's registration before the second attempt on the
  // same file — the live TASK-330 duplicate guard would otherwise refuse our
  // own resume. The watcher already delivered (finally ran session_shutdown),
  // so no live waiter still references the dropped entry.
  if (reuse) {
    for (const [id, running] of subagentsTest.runningSubagents as Map<string, { sessionFile?: string }>) {
      if (running.sessionFile === reuse.childSession) subagentsTest.runningSubagents.delete(id);
    }
  }
  let childSession = "";
  try {
    if (kind === "spawn") {
      const tool = tools.find((candidate) => candidate.name === "subagent");
      const result = await tool.execute("attempt", { name: "attemptworker", agent: "attemptworker", task, interactive: false }, undefined, undefined, ctx);
      assert.match(result.content[0].text, /launched and is now running/);
      const scriptsDir = join(root, "artifacts", "parent-id", "subagent-scripts");
      const script = readFileSync(join(scriptsDir, readdirSync(scriptsDir)[0]), "utf8");
      childSession = /PI_SUBAGENT_SESSION='([^']+)'/.exec(script)![1];
    } else {
      childSession = reuse!.childSession;
      // The fake herdr appends raw assistant lines, never a session header;
      // the live resume path reads the FIRST line as the header. Prepend a
      // valid header when missing (same as the retained task681 fixture) so
      // the failure under test is the watcher rejection, never the header.
      if (!existsSync(childSession) || !readFileSync(childSession, "utf8").startsWith('{"type":"session"')) {
        const prior = existsSync(childSession) ? readFileSync(childSession, "utf8") : "";
        mkdirSync(join(childSession, ".."), { recursive: true });
        writeFileSync(childSession, JSON.stringify({ type: "session", version: 3, id: "child-id", cwd: root }) + "\n" + prior, "utf8");
      }
      const tool = tools.find((candidate) => candidate.name === "subagent_resume");
      const result = await tool.execute("attempt", { sessionPath: childSession, name: "attemptworker", message: task }, undefined, undefined, ctx);
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
  console.log(`   [${kind}${failWatcher ? "-error" : ""}] details=${JSON.stringify(message!.details)}`);
  return { root, message: message!, childSession };
}

describe("per-attempt completion identity", () => {
  it("success-identity: spawn plus same-session resume carry distinct completion ids and keys", async () => {
    const task = "Task name: TASK-3 — same instructions";
    const first = await launch("spawn", false, task);
    const next = await launch("resume", false, task, first);
    assert.equal(next.childSession, first.childSession, "both attempts share one session file");
    const firstId = first.message.details.completionId;
    const nextId = next.message.details.completionId;
    assert.ok(firstId, "spawn attempt carries a completionId");
    assert.ok(nextId, "resume attempt carries a completionId");
    assert.notEqual(nextId, firstId, "attempts never reuse a completion id");
    assert.notEqual(completionKey(next.message.details), completionKey(first.message.details), "attempts never reuse a completion key");
  });

  it("error-identity: rejected spawn and resume watchers still carry distinct completion ids", async () => {
    const first = await launch("spawn", true, "Task name: TASK-3 — error attempt");
    const next = await launch("resume", true, "Task name: TASK-3 — error resume", first);
    assert.equal(first.message.details.error, "per-attempt injected watcher failure");
    assert.equal(next.message.details.error, "per-attempt injected watcher failure");
    assert.ok(first.message.details.completionId, "spawn error carries a completionId");
    assert.ok(next.message.details.completionId, "resume error carries a completionId");
    assert.notEqual(
      next.message.details.completionId,
      first.message.details.completionId,
      "error attempts never reuse a completion id",
    );
  });
});
