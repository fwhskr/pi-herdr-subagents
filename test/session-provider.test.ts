import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HerdrSubagentSessionProvider } from "../pi-extension/subagents/herdr-provider.ts";

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

describe("subagent session provider", () => {
  it("spawns, monitors, interrupts, collects, and closes without a Herdr binary", async () => {
    const dir = mkdtempSync(join(tmpdir(), "subagent-provider-test-"));
    const sessionFile = join(dir, "worker.jsonl");
    const exitFile = `${sessionFile}.exit`;
    writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: "session-1", cwd: dir })}\n`);

    const calls: string[] = [];
    let inspections = 0;
    const inheritedHerdrEnv = process.env.HERDR_ENV;
    delete process.env.HERDR_ENV;
    const provider = new HerdrSubagentSessionProvider({
      isAvailable: () => true,
      setupHint: () => "not needed",
      createSubagentPane(name) {
        calls.push(`spawn:${name}`);
        return "pane-1";
      },
      runScriptInPane(pane, command, options) {
        calls.push(`launch:${pane}:${command}`);
        assert.equal(options?.scriptPath, join(dir, "launch.sh"));
        return options?.scriptPath ?? "";
      },
      setPaneTask(pane, task) {
        calls.push(`task:${pane}:${task}`);
      },
      readPane(pane, lines) {
        calls.push(`collect:${pane}:${lines}`);
        return "collected provider output";
      },
      async readPaneAsync() {
        return "";
      },
      async inspectPane(pane) {
        inspections += 1;
        return { kind: "present" as const, observedAt: Date.now(), agentStatus: "working" as const, agent: pane };
      },
      interruptPane(pane) {
        calls.push(`interrupt:${pane}`);
      },
      closePane(pane) {
        calls.push(`close:${pane}`);
      },
    });

    try {
      // The fake availability operation proves the provider contract is usable
      // without consulting HERDR_ENV or invoking the herdr executable.
      assert.equal(provider.isAvailable(), true);
      const session = await provider.spawn({
        name: "Worker",
        task: "run bounded work",
        buildLaunch: (allocated) => {
          assert.equal(allocated.id, "pane-1");
          return { command: "echo worker", scriptPath: join(dir, "launch.sh") };
        },
      });
      assert.deepEqual(session, { id: "pane-1", name: "Worker" });

      const abort = new AbortController();
      const monitoring = provider.monitor(session, {
        signal: abort.signal,
        sessionFile,
        intervalMs: 1,
        onPaneInspection: () => {},
      });
      await sleep(5);
      provider.interrupt(session);
      writeFileSync(exitFile, JSON.stringify({ type: "done" }));
      const completion = await monitoring;

      assert.deepEqual(completion, { reason: "done", exitCode: 0 });
      assert.ok(inspections > 0, "monitor must inspect the running session");
      const collected = await provider.collectResult(session, completion);
      assert.deepEqual(collected, { output: "collected provider output" });
      provider.close(session);
      assert.deepEqual(calls.slice(0, 4), [
        "spawn:Worker",
        "task:pane-1:run bounded work",
        `launch:pane-1:echo worker`,
        "interrupt:pane-1",
      ]);
      assert.equal(calls.at(-2), "collect:pane-1:200");
      assert.equal(calls.at(-1), "close:pane-1");
    } finally {
      if (inheritedHerdrEnv === undefined) delete process.env.HERDR_ENV;
      else process.env.HERDR_ENV = inheritedHerdrEnv;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
