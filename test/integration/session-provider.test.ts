import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createTestEnv,
  cleanupTestEnv,
  sleep,
  type TestEnv,
} from "./harness.ts";
import { createHerdrSubagentSessionProvider } from "../../pi-extension/subagents/herdr-provider.ts";
import { isTerminalAvailable } from "../../pi-extension/subagents/terminal.ts";
import { shellQuote } from "../../pi-extension/subagents/session-provider.ts";

if (!isTerminalAvailable()) {
  console.log("⚠️  herdr is unavailable — skipping session provider integration test");
} else {
  describe("subagent session provider [herdr]", { timeout: 15_000 }, () => {
    let env: TestEnv;

    it("spawns, monitors, interrupts, and collects one live child session", async () => {
      env = createTestEnv("herdr");
      const provider = createHerdrSubagentSessionProvider();
      const sessionFile = join(env.dir, "provider-session.jsonl");
      const exitFile = `${sessionFile}.exit`;
      const launchScript = join(env.dir, "provider-launch.sh");
      writeFileSync(
        sessionFile,
        `${JSON.stringify({ type: "session", id: "provider-session", cwd: env.dir })}\n`,
      );

      let session;
      try {
        session = await provider.spawn({
          name: "Provider-live",
          task: "run the provider lifecycle proof",
          readyDelayMs: 1000,
          buildLaunch: () => ({
            command: `sleep 0.25; printf 'PROVIDER_LIVE_RESULT\\n'; printf '{"type":"done"}' > ${shellQuote(exitFile)}`,
            scriptPath: launchScript,
          }),
        });

        let inspections = 0;
        const monitor = provider.monitor(session, {
          signal: new AbortController().signal,
          sessionFile,
          intervalMs: 25,
          onPaneInspection: () => {
            inspections += 1;
          },
        });
        await sleep(75);
        provider.interrupt(session);
        const completion = await monitor;
        const collected = await provider.collectResult(session, completion);

        assert.deepEqual(completion, { reason: "done", exitCode: 0 });
        assert.ok(inspections > 0, "monitor must observe the live provider session");
        assert.match(collected.output, /PROVIDER_LIVE_RESULT/);
      } finally {
        if (session) provider.close(session);
        cleanupTestEnv(env);
      }
    });
  });
}
