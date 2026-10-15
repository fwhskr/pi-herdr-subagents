import { afterEach, describe, it } from "node:test";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { terminalTaskOfSession } from "../pi-extension/subagents/terminal-task.ts";

// TASK239_TEST_SCRATCH may point to an existing, narrowly writable scratch directory.
// By default all synthetic fixtures stay inside this source lane, never the live board.
const scratch = process.env.TASK239_TEST_SCRATCH ?? join(import.meta.dirname, "..");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function board(status: string, taskId = "TASK-237") {
  const root = mkdtempSync(join(scratch, ".task239-"));
  roots.push(root);
  mkdirSync(join(root, "backlog", "tasks"), { recursive: true });
  writeFileSync(join(root, "backlog", "tasks", `${taskId.toLowerCase()}.md`),
    `---\nid: ${taskId}\nstatus: ${status}\n---\n`);
  const child = join(root, "child.jsonl");
  writeFileSync(child, JSON.stringify({ type: "session", cwd: root }) + "\n");
  writeFileSync(`${child}.spawn.json`, JSON.stringify({ task: `Task name: ${taskId} — synthetic task` }));
  return { root, child };
}

function staleWorktree(root: string, child: string, status: string) {
  const git = (args: string[]) => execFileSync("git", args, {
    cwd: root, timeout: 5_000, stdio: ["ignore", "pipe", "pipe"],
  });
  git(["init", "-q"]);
  git(["add", "backlog/tasks"]);
  git(["-c", "user.name=Synthetic Fixture", "-c", "user.email=fixture@example.invalid",
    "-c", "core.hooksPath=/dev/null", "commit", "-qm", "synthetic board"]);
  const worktree = join(root, "worktree");
  git(["worktree", "add", "--detach", worktree, "HEAD"]);
  writeFileSync(join(worktree, "backlog", "tasks", "task-237.md"), `status: ${status}\n`);
  writeFileSync(child, JSON.stringify({ type: "session", cwd: worktree }) + "\n");
}

describe("TASK-239 project-bound terminal lookup", () => {
  it("cross-project-open: caller Done cannot refuse the resumed project's same-ID To Do task", () => {
    const parent = board("Done");
    const child = board("To Do");
    assert.equal(terminalTaskOfSession(child.child, [parent.root]), undefined);
  });

  it("cross-project-done: caller To Do cannot rescue the resumed project's same-ID Done task", () => {
    const parent = board("To Do");
    const child = board("Done");
    assert.deepEqual(terminalTaskOfSession(child.child, [parent.root]), { taskId: "TASK-237", status: "Done" });
  });

  it("cross-project-missing: missing child task cannot borrow the caller's same-ID Done status", () => {
    const parent = board("Done");
    const child = board("To Do");
    rmSync(join(child.root, "backlog", "tasks", "task-237.md"));
    assert.equal(terminalTaskOfSession(child.child, [parent.root]), undefined);
  });

  it("cross-project-unreadable: unreadable child task cannot borrow the caller's Done status", () => {
    const parent = board("Done");
    const child = board("To Do");
    const path = join(child.root, "backlog", "tasks", "task-237.md");
    rmSync(path);
    mkdirSync(path);
    assert.equal(terminalTaskOfSession(child.child, [parent.root]), undefined);
  });

  it("cross-project-distinct: only the exact child task ID decides", () => {
    const parent = board("Done", "TASK-238");
    const child = board("To Do");
    assert.equal(terminalTaskOfSession(child.child, [parent.root]), undefined);
    writeFileSync(join(child.root, "backlog", "tasks", "task-237.md"), "status: Done\n");
    assert.deepEqual(terminalTaskOfSession(child.child, [parent.root]), { taskId: "TASK-237", status: "Done" });
  });

  it("same-project-terminal: the session's terminal task still refuses", () => {
    const child = board("Done");
    assert.deepEqual(terminalTaskOfSession(child.child, [child.root]), { taskId: "TASK-237", status: "Done" });
  });

  it("same-project-open: the session's nonterminal task remains resumable", () => {
    const child = board("To Do");
    assert.equal(terminalTaskOfSession(child.child, [child.root]), undefined);
  });

  it("canonical-open: the resumed project's live board overrides its stale Done worktree", () => {
    const parent = board("Done");
    const child = board("To Do");
    staleWorktree(child.root, child.child, "Done");
    assert.equal(terminalTaskOfSession(child.child, [parent.root]), undefined);
  });

  it("canonical-terminal: the resumed project's live board overrides its stale open worktree", () => {
    const parent = board("To Do");
    const child = board("Done");
    staleWorktree(child.root, child.child, "To Do");
    assert.deepEqual(terminalTaskOfSession(child.child, [parent.root]), { taskId: "TASK-237", status: "Done" });
  });

  it("malformed-context: unnamed and unreadable sessions remain unknown; cwd-less named sessions retain caller fallback", () => {
    const parent = board("Done");
    const child = board("To Do");
    writeFileSync(`${child.child}.spawn.json`, "{malformed");
    writeFileSync(child.child, "not json\n");
    assert.equal(terminalTaskOfSession(child.child, [parent.root]), undefined);
    rmSync(child.child);
    assert.equal(terminalTaskOfSession(child.child, [parent.root]), undefined);
    writeFileSync(`${child.child}.spawn.json`, JSON.stringify({ task: "Task name: TASK-237" }));
    assert.deepEqual(terminalTaskOfSession(child.child, [parent.root]), { taskId: "TASK-237", status: "Done" });
  });
});
