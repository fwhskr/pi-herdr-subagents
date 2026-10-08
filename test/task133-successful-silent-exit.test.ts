import { after, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { __test__ as testApi } from "../pi-extension/subagents/index.ts";
import { createLifecycle } from "../pi-extension/subagents/lifecycle.ts";
import { __herdrTest__ } from "../pi-extension/subagents/herdr.ts";

const root = mkdtempSync("/home/kris/.pi/agent/var/task133-exit-");
const originalPath = process.env.PATH;
mkdirSync(join(root, "bin"));
writeFileSync(join(root, "bin/herdr"), "#!/bin/sh\nprintf '{}\\n'\n");
chmodSync(join(root, "bin/herdr"), 0o755);
process.env.PATH = `${join(root, "bin")}:${originalPath}`;
__herdrTest__.clearCommandAvailability();
after(() => { process.env.PATH = originalPath; __herdrTest__.clearCommandAvailability(); rmSync(root, { recursive: true, force: true }); });
const turn = [
  { type: "message", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "saved", name: "bash", arguments: { command: "git push" } }] } },
  { type: "message", message: { role: "toolResult", toolCallId: "saved", toolName: "bash", isError: false, content: [{ type: "text", text: "save complete" }] } },
];

for (const interactive of [false, true]) {
  it(`successful report-missing exit is not a failed lane (interactive=${interactive})`, async () => {
    const sessionFile = join(root, `child-${interactive}.jsonl`);
    writeFileSync(sessionFile, turn.map(entry => JSON.stringify(entry)).join("\n") + "\n");
    writeFileSync(`${sessionFile}.exit`, JSON.stringify({ type: "done" }));
    const startTime = Date.now();
    const running: any = { id: "silent", completionId: "current", name: "worker", task: "save", sessionFile, surface: "fixture", startTime, interactive, lifecycle: createLifecycle(startTime) };
    const result = await testApi.watchSubagent(running, new AbortController().signal);
    assert.equal(result.exitCode, 0);
    assert.equal(result.failureKind, undefined);
    assert.equal(result.reportMissing, true);
    assert.equal(running.lifecycle.process.kind, "completed");
    const presentation = testApi.resolveResultPresentation(result, "worker");
    assert.match(presentation, /exited successfully/i);
    assert.match(presentation, /no terminal report/i);
    assert.match(presentation, /not verified/i);
    assert.doesNotMatch(presentation, /retry|failed/i);
    const resumed = testApi.classifyResumeCompletion(turn, result);
    assert.equal(resumed.failureKind, undefined);
    assert.equal(resumed.reportMissing, true);
    assert.equal(resumed.summary, result.summary);
  });
}

it("nonzero exit, provider error and failed last tool stay failures", () => {
  for (const result of [{ exitCode: 1 }, { exitCode: 0, errorMessage: "provider error" }]) {
    const classified = testApi.classifyResumeCompletion(turn, result);
    assert.notEqual(classified.reportMissing, true);
  }
  const entries = [turn[0], { ...turn[1], message: { ...turn[1].message, isError: true } }];
  assert.equal(testApi.classifyResumeCompletion(entries, { exitCode: 0 }).failureKind, "reportless");
});

it("empty explicit done, aborted turns and forced stops are not report-missing successes", () => {
  const done = [turn[0], { ...turn[1], message: { ...turn[1].message, toolName: "subagent_done" } }];
  assert.equal(testApi.classifyResumeCompletion(done, { exitCode: 0 }).failureKind, "reportless");
  const aborted = [{ ...turn[0], message: { ...turn[0].message, stopReason: "aborted" } }, turn[1]];
  assert.notEqual(testApi.classifyResumeCompletion(aborted, { exitCode: 0 }).reportMissing, true);
  assert.notEqual(testApi.classifyResumeCompletion(turn, { exitCode: 0, failureKind: "watchdog" }).reportMissing, true);
});

it("a new empty resume cannot borrow successful tools from a previous attempt", () => {
  const result = testApi.classifyResumeCompletion([], { exitCode: 0 });
  assert.equal(result.failureKind, "reportless");
  assert.notEqual(result.reportMissing, true);
});
