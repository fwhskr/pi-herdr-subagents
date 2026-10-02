import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as subagentsModule from "../pi-extension/subagents/index.ts";
import { settledNoCloseCompletion } from "../pi-extension/subagents/index.ts";
import { readSubagentActivityFile } from "../pi-extension/subagents/activity.ts";
import {
  createLifecycle,
  observeActivity,
  observePaneInspection,
} from "../pi-extension/subagents/lifecycle.ts";

// TASK-19 regression: a delegated lane the parent asked to interrupt (recovery
// nudge / explicit interrupt) ends its turn with stopReason error/aborted and
// stays open — Escape disarms child auto-exit, so no sidecar is written and
// settledNoCloseCompletion deliberately declines the aborted stop. Before the
// repair the orchestrator saw only a quiet pane and resumed a lane the parent
// itself stopped (TASK-615: nudge -> "Command aborted" -> stopReason error ->
// exit 129, no completion). The repair concludes that settled, nudged, aborted
// lane as a terminal interrupted outcome: failureKind interrupted, exitCode 130.
// Run (bounded): timeout 120 node --experimental-strip-types --test test/task19-interrupted-mid-wait.test.ts

const testApi = (subagentsModule as any).__test__;
const tempDirs = new Set<string>();

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
  (testApi.runningSubagents as Map<string, any>)?.clear();
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
    timestamp: "2026-10-02T18:45:23.000Z",
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

/** The real parent-side lifecycle for a lane Herdr saw working then idle and
 *  whose own activity snapshot says it settled with no close. */
function settledLifecycle(runningChildId: string, settledAt: number) {
  const activityFile = join(tempDir("t19-activity-"), "child.activity.json");
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

describe("TASK-19 a parent-interrupted lane that settled on an aborted turn", () => {
  it("delivers failureKind interrupted with exitCode 130 once the parent nudged the wait and the grace elapsed", () => {
    const dir = tempDir("t19-interrupted-");
    const sessionFile = writeSession(dir, "lane.jsonl", [assistantEntry("Command aborted", "aborted")]);
    const settledAt = 1_000_000;
    const now = settledAt + 31_000;
    const lifecycle = settledLifecycle("child-t19", settledAt);
    const running = {
      id: "child-t19",
      name: "engineer",
      task: "TASK-19",
      sessionFile,
      startTime: settledAt - 600_000,
      interactive: false,
      lifecycle,
      interruptNudgedAt: settledAt - 5_000,
    };

    // The ordinary settled-no-close path deliberately declines the aborted stop.
    assert.equal(
      settledNoCloseCompletion(running, now),
      null,
      "the unmodified settled-no-close path must not claim an aborted stop",
    );

    // The TASK-19 repair concludes it as interrupted.
    const state = testApi.settledInterruptedState(running, now, 0, 0);
    assert.ok(state, "a nudged lane settled on an aborted turn is a terminal interrupted outcome");
    assert.match(state.errorMessage, /interrupted by parent/i);
    assert.equal(state.interruptedAt, running.interruptNudgedAt);

    // The delivery the watcher builds from that state carries the failure kind
    // and exit code the orchestrator sees.
    running.interrupted = state;
    const result = testApi.buildInterruptedResult(running, now);
    assert.ok(result, "the interrupted state builds a terminal result");
    assert.equal(result.failureKind, "interrupted");
    assert.equal(result.exitCode, 130);
    assert.equal(result.error, "interrupted");
  });

  it("does not over-suppress: an un-nudged, interactive, still-in-grace or cleanly-stopped lane stays unchanged", () => {
    const dir = tempDir("t19-controls-");
    const settledAt = 2_000_000;
    const now = settledAt + 31_000;
    const aborted = writeSession(dir, "aborted.jsonl", [assistantEntry("Command aborted", "aborted")]);
    const clean = writeSession(dir, "clean.jsonl", [assistantEntry("FINAL REPORT: done.", "stop")]);
    const lifecycle = settledLifecycle("child-control", settledAt);

    const base = {
      id: "child-control",
      name: "engineer",
      task: "TASK-19",
      startTime: settledAt - 600_000,
      interactive: false,
      lifecycle,
    };

    // (a) no parent nudge -> the repair never fires
    assert.equal(
      testApi.settledInterruptedState({ ...base, sessionFile: aborted }, now, 0, 0),
      null,
      "an un-nudged aborted settle is not an interrupted outcome",
    );
    // (b) an interactive lane is out of scope
    assert.equal(
      testApi.settledInterruptedState({ ...base, sessionFile: aborted, interactive: true, interruptNudgedAt: settledAt - 5_000 }, now, 0, 0),
      null,
      "an interactive lane is never concluded by the watcher",
    );
    // (c) the bounded grace has not elapsed
    assert.equal(
      testApi.settledInterruptedState({ ...base, sessionFile: aborted, interruptNudgedAt: settledAt - 5_000 }, settledAt + 10_000, 0, 30_000),
      null,
      "inside the grace window the lane is not yet concluded",
    );
    // (d) a clean stop is not an aborted settle
    assert.equal(
      testApi.settledInterruptedState({ ...base, sessionFile: clean, interruptNudgedAt: settledAt - 5_000 }, now, 0, 0),
      null,
      "a clean stop is not an interrupted outcome",
    );
    // (e) a terminal lifecycle is not re-concluded
    const terminal = { ...base, lifecycle: { ...lifecycle, process: { kind: "completed" as const, startedAt: settledAt - 600_000 } } };
    assert.equal(
      testApi.settledInterruptedState({ ...terminal, sessionFile: aborted, interruptNudgedAt: settledAt - 5_000 }, now, 0, 0),
      null,
      "an already-terminal lifecycle is not re-concluded",
    );
  });
});
