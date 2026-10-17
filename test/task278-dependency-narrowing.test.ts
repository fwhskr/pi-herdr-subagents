import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSubagentActivityRecorder,
  readSubagentActivityFile,
  type ProcessStatReadResult,
} from "../pi-extension/subagents/activity.ts";
import { probeWorkerProcess } from "../pi-extension/subagents/completion.ts";

const RUN = "run-task278";

const baseActivity = {
  version: 1,
  runningChildId: RUN,
  createdAt: 1,
  updatedAt: 1,
  sequence: 0,
  latestEvent: "session_start",
  phase: "starting",
  agentActive: false,
  turnActive: false,
  providerActive: false,
  toolActive: false,
};

function readWithExtra(extra: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "task278-activity-"));
  try {
    const file = join(dir, "activity.json");
    writeFileSync(file, JSON.stringify({ ...baseActivity, ...extra }));
    return readSubagentActivityFile(file, RUN);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("activity worker identity validation fails closed (TASK-278)", () => {
  it("accepts a positive safe integer identity pair", () => {
    const read = readWithExtra({ workerPid: 42, workerStartTime: 7 });
    assert.equal(read.ok, true);
  });

  for (const [field, value, message] of [
    ["workerPid", "42", "workerPid must be a positive safe integer when present"],
    ["workerPid", 0, "workerPid must be a positive safe integer when present"],
    ["workerPid", -1, "workerPid must be a positive safe integer when present"],
    ["workerPid", 1.5, "workerPid must be a positive safe integer when present"],
    ["workerPid", Number.MAX_SAFE_INTEGER + 1, "workerPid must be a positive safe integer when present"],
    ["workerStartTime", "7", "workerStartTime must be a positive safe integer when present"],
    ["workerStartTime", 0, "workerStartTime must be a positive safe integer when present"],
    ["workerStartTime", 2.5, "workerStartTime must be a positive safe integer when present"],
  ] as const) {
    it(`rejects ${field}=${JSON.stringify(value)} with a precise error`, () => {
      const other = field === "workerPid" ? { workerStartTime: 7 } : { workerPid: 42 };
      const read = readWithExtra({ ...other, [field]: value });
      assert.equal(read.ok, false);
      assert.deepEqual(read, { ok: false, reason: "invalid", error: message });
    });
  }
});

describe("activity recorder activityFile normalisation (TASK-278)", () => {
  it("treats a whitespace-only activityFile as no file configured", () => {
    const recorder = createSubagentActivityRecorder({ runningChildId: RUN, activityFile: "   " });
    recorder.sessionStart();
    assert.equal(recorder.currentPhase(), undefined);
  });

  it("trims padding and writes the activity file at the trimmed path", () => {
    const dir = mkdtempSync(join(tmpdir(), "task278-recorder-"));
    try {
      const file = join(dir, "activity.json");
      const recorder = createSubagentActivityRecorder({ runningChildId: RUN, activityFile: `  ${file}  ` });
      recorder.sessionStart();
      assert.equal(recorder.currentPhase(), "starting");
      assert.equal(existsSync(file), true);
      assert.equal(readSubagentActivityFile(file, RUN).ok, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("worker process probe refuses malformed identity (TASK-278)", () => {
  function countingStat(result: ProcessStatReadResult) {
    let calls = 0;
    return {
      calls: () => calls,
      read: (_pid: number): ProcessStatReadResult => {
        calls += 1;
        return result;
      },
    };
  }

  for (const identity of [
    { pid: 0, startTime: 7 },
    { pid: 42, startTime: 0 },
    { pid: 1.5, startTime: 7 },
    { pid: 42, startTime: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    it(`reports unknown without reading /proc for ${JSON.stringify(identity)}`, () => {
      const stat = countingStat({ kind: "present", identity, state: "S" });
      assert.equal(probeWorkerProcess(identity, stat.read), "unknown");
      assert.equal(stat.calls(), 0);
    });
  }

  it("reports alive only for the same identity in a live state", () => {
    const identity = { pid: 42, startTime: 7 };
    assert.equal(probeWorkerProcess(identity, countingStat({ kind: "present", identity, state: "S" }).read), "alive");
    assert.equal(probeWorkerProcess(identity, countingStat({ kind: "present", identity, state: "Z" }).read), "dead");
    assert.equal(
      probeWorkerProcess(identity, countingStat({ kind: "present", identity: { pid: 42, startTime: 8 }, state: "S" }).read),
      "dead",
    );
    assert.equal(probeWorkerProcess(identity, countingStat({ kind: "missing" }).read), "dead");
    assert.equal(probeWorkerProcess(identity, countingStat({ kind: "unknown" }).read), "unknown");
  });
});
