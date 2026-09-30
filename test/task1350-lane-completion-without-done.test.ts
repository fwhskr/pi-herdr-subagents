import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as subagentsModule from "../pi-extension/subagents/index.ts";
import { settledNoCloseCompletion, findActiveSessionRun } from "../pi-extension/subagents/index.ts";
import { waitForCompletion } from "../pi-extension/subagents/completion.ts";
import { findTerminalReport, getNewEntries } from "../pi-extension/subagents/session.ts";
import { readSubagentActivityFile } from "../pi-extension/subagents/activity.ts";
import {
  createLifecycle,
  observeActivity,
  observePaneInspection,
} from "../pi-extension/subagents/lifecycle.ts";

// TASK-1350: a delegated lane whose last assistant text is a final report and
// which ends its turn WITHOUT subagent_done/caller_ping must not be reported as
// a lost lane. Its completion is recovered from its own session within the
// bounded settled grace, and its run registration is reaped so resume is no
// longer refused. A lane that genuinely died mid-work stays lost.
// Run: timeout 120 node --experimental-strip-types --test test/task1350-lane-completion-without-done.test.ts

const testApi = (subagentsModule as any).__test__;
const tempDirs = new Set<string>();

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
  (testApi.runningSubagents as Map<string, any>).clear();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.add(dir);
  return dir;
}

function assistantEntry(text: string, stopReason: string, errorMessage?: string) {
  return {
    type: "message",
    id: `assistant-${stopReason}`,
    parentId: "root",
    timestamp: "2026-09-30T19:28:57.000Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      stopReason,
      ...(errorMessage ? { errorMessage } : {}),
    },
  };
}

function writeSession(dir: string, name: string, entries: object[]): string {
  const file = join(dir, name);
  writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
  return file;
}

/** A settled-with-no-close activity snapshot exactly as the child writes it. */
function settledActivity(runningChildId: string, settledAt: number) {
  return {
    version: 1 as const,
    runningChildId,
    createdAt: 0,
    updatedAt: settledAt,
    sequence: 7,
    latestEvent: "agent_end" as const,
    phase: "waiting" as const,
    agentActive: false,
    turnActive: false,
    providerActive: false,
    toolActive: false,
    waitingSince: settledAt,
    settledAt,
  };
}

/**
 * The real parent-side lifecycle for a lane Herdr saw working then idle and
 * whose own activity snapshot says it settled with no close.
 */
function settledLifecycle(runningChildId: string, settledAt: number) {
  const activityFile = join(tempDir("t1350-activity-"), "child.activity.json");
  writeFileSync(activityFile, JSON.stringify(settledActivity(runningChildId, settledAt)) + "\n", "utf8");
  const read = readSubagentActivityFile(activityFile, runningChildId);
  assert.ok(read.ok, "fixture activity snapshot is valid");
  let lifecycle = createLifecycle(settledAt - 60_000);
  lifecycle = observePaneInspection(lifecycle, { kind: "present", agentStatus: "working", observedAt: settledAt - 1_000 }, settledAt - 1_000);
  lifecycle = observePaneInspection(lifecycle, { kind: "present", agentStatus: "idle", observedAt: settledAt }, settledAt);
  lifecycle = observeActivity(lifecycle, read, settledAt);
  assert.equal(lifecycle.settledAt, settledAt, "settled marker carried onto the lifecycle");
  return lifecycle;
}

describe("TASK-1350 a lane that ends without subagent_done", () => {
  it("AC1: reproduces the condition deterministically with exact session/activity evidence", () => {
    const dir = tempDir("t1350-fixture-");
    const report = "FINAL REPORT: 256/0/0, commit 76d7cc34, worktree clean.";
    const sessionFile = writeSession(dir, "artist.jsonl", [assistantEntry(report, "stop")]);
    const settledAt = 1_000_000;
    const activityFile = join(dir, "artist.activity.json");
    writeFileSync(activityFile, JSON.stringify(settledActivity("child-1350", settledAt)) + "\n", "utf8");

    const read = readSubagentActivityFile(activityFile, "child-1350");
    assert.ok(read.ok);
    assert.equal(read.activity.latestEvent, "agent_end");
    assert.equal(read.activity.agentActive, false);
    assert.equal(read.activity.turnActive, false);
    assert.equal(typeof read.activity.settledAt, "number");

    const sizeBefore = statSync(sessionFile).size;
    const lifecycle = settledLifecycle("child-1350", settledAt);
    const result = settledNoCloseCompletion(
      { sessionFile, interactive: false, lifecycle },
      settledAt + 31_000,
    );
    assert.ok(result, "a settled lane whose last turn is a final report is a completion candidate");
    assert.equal(result!.reason, "settled-no-close");
    assert.equal(result!.exitCode, 0);
    assert.equal(statSync(sessionFile).size, sizeBefore, "no further session writes after the settle");
    assert.equal(findTerminalReport(getNewEntries(sessionFile, 0)), report, "the report is read from the lane's own session");
  });

  it("AC2: the watcher concludes the lane with its own report, never as a lost lane", async () => {
    const dir = tempDir("t1350-watch-");
    const report = "FINAL REPORT: six zero-pixel before/after renders, SWEEP CLEAN.";
    const sessionFile = writeSession(dir, "artist.jsonl", [assistantEntry(report, "stop")]);
    const settledAt = 2_000_000;
    const lifecycle = settledLifecycle("child-1350", settledAt);
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 3_000);
    let result;
    try {
      result = await waitForCompletion(controller.signal, {
        intervalMs: 1,
        sessionFile,
        readTerminalTail: async () => "",
        readSettledNoCloseCompletion: () =>
          settledNoCloseCompletion({ sessionFile, interactive: false, lifecycle }, settledAt + 31_000),
      });
    } finally {
      clearTimeout(deadline);
    }
    assert.equal(result.reason, "settled-no-close");
    const entries = getNewEntries(sessionFile, 0);
    assert.equal(testApi.isReportlessCompletion(entries, result), false, "a report exists, so this is not reportless");

    const presentation = testApi.resolveResultPresentation(
      {
        ...result,
        summary: findTerminalReport(entries),
        sessionFile,
        elapsed: 31,
        finishedWithoutClose: true,
      },
      "artist",
    );
    assert.match(presentation, /finished without closing/i);
    assert.match(presentation, /FINAL REPORT: six zero-pixel before\/after renders, SWEEP CLEAN\./);
    assert.ok(presentation.includes(sessionFile), "the report location is named");
    assert.doesNotMatch(presentation, /exited without producing a result/i);
  });

  it("AC3: the settled run is reaped so resume is no longer refused; a working lane keeps the guard", () => {
    const dir = tempDir("t1350-reap-");
    const settledFile = writeSession(dir, "settled.jsonl", [assistantEntry("done", "stop")]);
    const workingFile = writeSession(dir, "working.jsonl", [assistantEntry("still working", "toolUse")]);
    const settledAt = 3_000_000;

    const settledRunning: any = {
      id: "child-settled",
      name: "artist",
      sessionFile: settledFile,
      interactive: false,
      lifecycle: settledLifecycle("child-settled", settledAt),
    };
    const workingRunning: any = {
      id: "child-working",
      name: "artist",
      sessionFile: workingFile,
      interactive: false,
      lifecycle: createLifecycle(settledAt),
    };
    const map = testApi.runningSubagents as Map<string, any>;
    map.set(settledRunning.id, settledRunning);
    map.set(workingRunning.id, workingRunning);

    assert.equal(findActiveSessionRun(settledFile)?.id, "child-settled", "baseline: registration blocks resume");
    assert.equal(findActiveSessionRun(workingFile)?.id, "child-working");

    // The completion is admitted, then the delivery path removes the run from
    // the registry — the same reap every completion performs.
    assert.ok(settledNoCloseCompletion(settledRunning, settledAt + 31_000));
    map.delete(settledRunning.id);
    assert.equal(findActiveSessionRun(settledFile), undefined, "reaped lane no longer blocks resume");

    // Guard branch: a genuinely working lane is not reapable and still blocks.
    assert.equal(settledNoCloseCompletion(workingRunning, settledAt + 31_000), null);
    assert.equal(findActiveSessionRun(workingFile)?.id, "child-working", "working lane keeps the refusal");
  });

  it("AC4: a lane that genuinely died mid-work stays lost (no over-suppression)", async () => {
    const dir = tempDir("t1350-dead-");
    const settledAt = 4_000_000;
    const lifecycle = settledLifecycle("child-dead", settledAt);

    // (a) cut off mid-turn: a text fragment but stopReason toolUse is not a terminal report.
    const cutOffFile = writeSession(dir, "cutoff.jsonl", [assistantEntry("working on it", "toolUse")]);
    assert.equal(
      settledNoCloseCompletion({ sessionFile: cutOffFile, interactive: false, lifecycle }, settledAt + 31_000),
      null,
      "a mid-turn cut-off must not be admitted as a completion",
    );

    // (b) provider-error turn with text: still a failure, not a completion.
    const errorFile = writeSession(dir, "error.jsonl", [assistantEntry("partial", "error", "Anthropic 529 Overloaded")]);
    assert.equal(
      settledNoCloseCompletion({ sessionFile: errorFile, interactive: false, lifecycle }, settledAt + 31_000),
      null,
      "a provider-error turn must stay a failure",
    );

    // (c) no settled marker at all: an ordinary active lane is not completed.
    const activeFile = writeSession(dir, "active.jsonl", [assistantEntry("looks final", "stop")]);
    assert.equal(
      settledNoCloseCompletion(
        { sessionFile: activeFile, interactive: false, lifecycle: createLifecycle(settledAt) },
        settledAt + 31_000,
      ),
      null,
      "without the settled marker the lane is not completed",
    );

    // (d) the unchanged lost-lane path still fires when the pane disappears.
    const missing = await waitForCompletion(new AbortController().signal, {
      intervalMs: 1,
      sessionFile: cutOffFile,
      readTerminalTail: async () => "",
      inspectPane: async () => ({ kind: "missing", detectedAt: Date.now(), consecutiveMissing: 2 }),
    });
    assert.equal(missing.reason, "error");
    assert.match(missing.errorMessage ?? "", /pane disappeared before completion evidence/i);
  });
});
