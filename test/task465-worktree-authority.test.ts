import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import subagentsExtension, { __test__ as subagentsTest } from "../pi-extension/subagents/index.ts";
import { __herdrTest__ } from "../pi-extension/subagents/herdr.ts";

// TASK-465 (TASK-458 residual r2): the terminal-task authority root was the
// resuming session's cwd verbatim, so a Nova resuming from a stale git worktree
// W was judged by W's board copy instead of the main checkout M's live board.
// Drives the REAL subagent_resume tool with ctx.cwd = W over a real
// `git worktree add` layout.
//
// Run: timeout 60 node --test --test-name-pattern='<selector>' test/task465-worktree-authority.test.ts
// Selectors: "wt-stale-done" (AC1a), "wt-stale-open" + "wt-unrecorded" (AC1b),
//            "wt-agree" (AC4a), "no-repo" (AC4c)

const ENV_NAMES = [
  "HERDR_ENV", "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID", "PATH", "PI_CODING_AGENT_DIR",
  "PI_SUBAGENT_ID", "PI_SUBAGENT_AGENT", "PI_SUBAGENT_SHELL_READY_DELAY_MS",
] as const;
const originalEnv = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
const bases: string[] = [];

afterEach(() => {
  for (const name of ENV_NAMES) {
    const value = originalEnv[name];
    if (value == null) delete process.env[name];
    else process.env[name] = value;
  }
  subagentsTest.runningSubagents.clear();
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
});

const TASK_FILE = join("backlog", "tasks", "task-451 - Rootless-diagnoseNovaState.md");
const BRIEF = "Task name: TASK-451 — independent verification\n\nYou are the gate.";
const board = (dir: string, status: string) => {
  mkdirSync(join(dir, "backlog", "tasks"), { recursive: true });
  writeFileSync(join(dir, TASK_FILE), `---\nid: TASK-451\nstatus: ${status}\n---\n`, "utf8");
};
const git = (cwd: string, ...args: string[]) => execFileSync("git", [
  "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args,
], { cwd, stdio: "ignore", timeout: 10_000 });

/**
 * Main checkout M (a git repo whose board says `mainStatus`), linked worktree W
 * whose board copy says `worktreeStatus` (null: W does not record the task), a
 * lane session that ran in W, and a fake herdr. `repo: false` makes the
 * resuming cwd a plain directory outside any repository.
 */
function layout(mainStatus: string, worktreeStatus: string | null, repo = true) {
  const base = mkdtempSync(join(tmpdir(), "task465-"));
  bases.push(base);
  const main = join(base, "main");
  const worktree = join(base, "worktree");
  board(main, mainStatus);
  if (repo) {
    git(main, "init", "-q");
    git(main, "add", ".");
    git(main, "commit", "-q", "--no-verify", "-m", "board");
    git(main, "worktree", "add", "-q", "--detach", worktree, "HEAD");
    if (worktreeStatus === null) rmSync(join(worktree, TASK_FILE));
    else board(worktree, worktreeStatus);
  } else if (worktreeStatus !== null) board(worktree, worktreeStatus);
  else mkdirSync(worktree);
  const child = join(base, "child.jsonl");
  writeFileSync(child, JSON.stringify({ type: "session", version: 3, id: "child-id", cwd: worktree }) + "\n", "utf8");
  writeFileSync(`${child}.spawn.json`, JSON.stringify({ name: "echo", agent: "echo", task: BRIEF, childSessionFile: child }), "utf8");
  const bin = join(base, "bin");
  mkdirSync(bin);
  const runs = join(base, "pane-runs.log");
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
elif args[:2] == ["pane", "run"]:
    open(${JSON.stringify(runs)}, "a").write(" ".join(args) + "\\n")
`, "utf8");
  chmodSync(join(bin, "herdr"), 0o755);
  mkdirSync(join(base, "agent", "agents"), { recursive: true });
  Object.assign(process.env, {
    PATH: `${bin}:${originalEnv.PATH ?? ""}`, HERDR_ENV: "1", HERDR_PANE_ID: "parent-pane", HERDR_TAB_ID: "parent-tab",
    HERDR_WORKSPACE_ID: "parent-workspace", PI_CODING_AGENT_DIR: join(base, "agent"), PI_SUBAGENT_SHELL_READY_DELAY_MS: "0",
  });
  delete process.env.PI_SUBAGENT_ID;
  delete process.env.PI_SUBAGENT_AGENT;
  __herdrTest__.clearCommandAvailability();
  const paneRuns = () => (existsSync(runs) ? readFileSync(runs, "utf8").trim().split("\n").filter(Boolean).length : 0);
  return { base, worktree, child, paneRuns };
}

/** Call the REAL subagent_resume tool from a Nova session whose cwd (ctx.cwd) is `cwd`. */
async function resumeFrom(cwd: string, base: string, sessionPath: string) {
  const handlers = new Map<string, Function>();
  const tools: any[] = [];
  const api = {
    on(event: string, handler: Function) { handlers.set(event, handler); },
    registerTool(tool: any) { tools.push(tool); },
    registerCommand() {}, registerMessageRenderer() {}, registerShortcut() {},
    getAllTools() { return []; }, getThinkingLevel() { return "medium"; },
    sendUserMessage() {}, appendEntry() {}, sendMessage() {},
  } as any;
  const parent = join(base, "parent.jsonl");
  writeFileSync(parent, JSON.stringify({ type: "session", version: 3, id: "parent-id", cwd }) + "\n", "utf8");
  const ctx = {
    cwd, hasUI: true, mode: "tui", isProjectTrusted: () => true,
    model: { provider: "fake", id: "parent" },
    modelRegistry: { find: () => ({ provider: "fake", id: "parent", reasoning: true }), getAvailable: () => [], hasConfiguredAuth: () => true },
    sessionManager: { getSessionFile: () => parent, getSessionId: () => "parent-id", getSessionDir: () => base },
    ui: { notify() {}, setWidget() {}, setStatus() {} },
  } as any;
  subagentsExtension(api);
  handlers.get("session_start")?.({}, ctx);
  try {
    const tool = tools.find((candidate) => candidate.name === "subagent_resume");
    return await tool.execute("task465", { sessionPath, name: "Resume echo", message: "Re-orient and finish." }, undefined, undefined, ctx);
  } finally {
    handlers.get("session_shutdown")?.({ reason: "exit" }, ctx);
  }
}

async function expectVerdict(label: string, mainStatus: string, worktreeStatus: string | null, verdict: "started" | "refused", repo = true) {
  const { base, worktree, child, paneRuns } = layout(mainStatus, worktreeStatus, repo);
  const result = await resumeFrom(worktree, base, child);
  const text = result.content[0].text as string;
  console.log(`   [${label}] status=${result.details?.status} taskStatus=${result.details?.taskStatus} paneRuns=${paneRuns()} text=${JSON.stringify(text.slice(0, 140))}`);
  assert.equal(result.details?.status, verdict);
  if (verdict === "refused") {
    assert.equal(result.details?.error, "terminal task");
    assert.equal(result.details?.taskStatus, "Done");
    assert.match(text, /TASK-451 is already terminal \(status: Done\)/);
    assert.equal(paneRuns(), 0);
  } else {
    assert.equal(paneRuns(), 1);
  }
}

describe("TASK-465 worktree authority root", () => {
  it("wt-stale-done: resuming from a stale worktree saying Done does not refuse a task the main checkout holds open", async () => {
    await expectVerdict("wt-stale-done", "In Progress", "Done", "started");
  });

  it("wt-stale-open: resuming from a stale worktree saying In Progress is refused when the main checkout holds Done", async () => {
    await expectVerdict("wt-stale-open", "Done", "In Progress", "refused");
  });

  it("wt-unrecorded: resuming from a worktree that does not record the task is refused when the main checkout holds Done", async () => {
    await expectVerdict("wt-unrecorded", "Done", null, "refused");
  });

  it("wt-agree: a worktree board that agrees with the main checkout behaves as before", async () => {
    await expectVerdict("wt-agree-done", "Done", "Done", "refused");
    await expectVerdict("wt-agree-open", "In Progress", "In Progress", "started");
  });

  it("no-repo: a resuming cwd outside any repository is judged by its own board, as before", async () => {
    await expectVerdict("no-repo-done", "In Progress", "Done", "refused", false);
    await expectVerdict("no-repo-open", "Done", "In Progress", "started", false);
    await expectVerdict("no-repo-none", "Done", null, "started", false);
  });
});
