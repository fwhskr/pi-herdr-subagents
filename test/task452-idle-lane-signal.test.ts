import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import * as subagentsModule from "../pi-extension/subagents/index.ts";
import {
  createLifecycle,
  lifecycleTransition,
  markCompletionDetected,
  observeActivity,
  observePaneInspection,
  projectLifecycle,
  type SubagentLifecycle,
} from "../pi-extension/subagents/lifecycle.ts";

const IDLE_MS = 600_000;
const testApi = (subagentsModule as any).__test__;

/** Worker did work, then its turn ended with no close: Herdr reports the pane idle. */
function noCloseLifecycle(idleAt: number): SubagentLifecycle {
  let lifecycle = createLifecycle(0);
  lifecycle = observePaneInspection(lifecycle, { kind: "present", agentStatus: "working", observedAt: 1_000 }, 1_000);
  return observePaneInspection(lifecycle, { kind: "present", agentStatus: "idle", observedAt: idleAt }, idleAt);
}

function waitingActivity(at: number, sequence: number) {
  return {
    ok: true as const,
    activity: {
      version: 1 as const,
      runningChildId: "child-452",
      createdAt: 0,
      updatedAt: at,
      sequence,
      latestEvent: "agent_end" as const,
      phase: "waiting" as const,
      agentActive: false,
      turnActive: false,
      providerActive: false,
      toolActive: false,
      waitingSince: at,
    },
  };
}

describe("TASK-452 no-close lane on the real lifecycle path", () => {
  it("a lane idle with no close projects idle once the bound elapses and emits an idle transition", () => {
    const lifecycle = noCloseLifecycle(2_000);
    assert.equal(projectLifecycle(lifecycle, 2_000 + IDLE_MS - 1).kind, "waiting", "below the bound stays waiting");
    const projection = projectLifecycle(lifecycle, 2_000 + IDLE_MS);
    assert.equal(projection.kind, "idle", "at the bound a no-close idle lane is surfaced as idle");
    assert.equal(projection.stateDurationSince, 2_000);
    assert.equal(lifecycleTransition("waiting", projection.kind), "idle");
    assert.equal(lifecycleTransition("idle", projection.kind), null, "one-shot per idle episode");
  });

  it("an activity-only lane (Herdr status unknown) that settled without a close is surfaced too", () => {
    let lifecycle = createLifecycle(0);
    lifecycle = observeActivity(lifecycle, {
      ok: true,
      activity: { ...waitingActivity(1_000, 1).activity, latestEvent: "agent_start", phase: "active", agentActive: true, activeScope: "agent", activeSince: 1_000 },
    } as any, 1_000);
    assert.equal(projectLifecycle(lifecycle, 1_001).kind, "active");
    lifecycle = observeActivity(lifecycle, waitingActivity(2_000, 2) as any, 2_000);
    assert.equal(projectLifecycle(lifecycle, 2_000 + IDLE_MS).kind, "idle");
  });

  it("control: a lane that closed (completion detected) is never reported idle", () => {
    const lifecycle = markCompletionDetected(noCloseLifecycle(2_000), { type: "done" } as any, 3_000);
    assert.equal(projectLifecycle(lifecycle, 3_000 + 10 * IDLE_MS).kind, "finalizing");
  });
});

describe("TASK-452 idle-lane signal wakes the delegator through the status refresh loop", () => {
  function runLoop(interactive: boolean) {
    mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });
    const sent: Array<{ message: any; options: any }> = [];
    const pi = { sendMessage: (message: any, options: any) => sent.push({ message, options }) };
    const running: any = {
      id: "child-452",
      name: "Worker",
      task: "ends its turn without a close",
      surface: "pane-452",
      startTime: 0,
      sessionFile: "/tmp/task452-worker.jsonl",
      interactive,
      lifecycle: noCloseLifecycle(2_000),
    };
    testApi.runningSubagents.set(running.id, running);
    try {
      testApi.startStatusRefresh(pi);
      mock.timers.tick(3_000);
      const before = sent.length;
      mock.timers.tick(IDLE_MS);
      const atBound = sent.length;
      mock.timers.tick(3 * IDLE_MS);
      return { sent, before, atBound, after: sent.length };
    } finally {
      testApi.runningSubagents.delete(running.id);
      mock.timers.tick(1_000); // empty map clears the interval
      mock.timers.reset();
    }
  }

  it("sends exactly one triggerTurn steer naming the idle lane", () => {
    const { sent, before, atBound, after } = runLoop(false);
    assert.equal(before, 0, "no wake below the bound");
    assert.equal(atBound, 1, "one wake at the bound");
    assert.equal(after, 1, "bounded: no repeat while the lane stays idle");
    assert.equal(sent[0].options.triggerTurn, true);
    assert.match(String(sent[0].message.content), /Worker .*idle 10m.*no close/);
  });

  it("control: an interactive lane is not woken (user drives the pane)", () => {
    assert.equal(runLoop(true).after, 0);
  });
});
