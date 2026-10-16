import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { __test__ as subagentsTest } from "../pi-extension/subagents/index.ts";

// TASK-261: upstream guarded the widget refresh against a ctx that went stale
// after /reload. Downstream renders per owning session, so the guard must
// drop only the stale session context and keep refreshing the live ones.
afterEach(() => {
  subagentsTest.sessionCtxs.clear();
  subagentsTest.runningSubagents.clear();
});

describe("TASK-261 stale widget ctx", () => {
  it("drops a stale session ctx without blocking live session widgets", () => {
    const calls: string[] = [];
    const stale = {
      get hasUI(): boolean {
        throw new Error("This extension ctx is stale after session replacement or reload");
      },
      ui: { setWidget: () => calls.push("stale") },
    };
    const live = {
      hasUI: true,
      ui: { setWidget: (key: string) => calls.push(`live:${key}`) },
    };
    subagentsTest.sessionCtxs.set("stale-owner", stale as any);
    subagentsTest.sessionCtxs.set("live-owner", live as any);

    assert.doesNotThrow(() => subagentsTest.updateWidget());
    assert.equal(subagentsTest.sessionCtxs.has("stale-owner"), false);
    assert.equal(subagentsTest.sessionCtxs.get("live-owner"), live);
    assert.deepEqual(calls, ["live:subagent-status"]);
  });
});
