import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractTerminalReportFromMessage, findTerminalReport } from "../pi-extension/subagents/session.ts";

const msg = (texts: string[], report?: string) => ({
  role: "assistant",
  content: [
    ...texts.map((text) => ({ type: "text", text })),
    { type: "toolCall", toolName: "subagent_done", toolCallId: "tc", arguments: report ? { report } : {} },
  ],
  stopReason: "toolUse",
});

describe("TASK-391 report-argument precedence", () => {
  it("red-first: a longer report argument is not discarded for a short status text", () => {
    const long = "FULL REPORT ".repeat(50);
    // extractSubagentDoneReport returns report.trim(), so compare trim-safe.
    assert.equal(extractTerminalReportFromMessage(msg(["No blockers. Final report:"], long)), long.trim());
  });
  it("keeps the same-message text when it is the longer, substantive field", () => {
    const long = "REPORT ".repeat(50);
    assert.equal(extractTerminalReportFromMessage(msg([long], "ok")), long);
  });
  it("admission uses the same recovered value", () => {
    const entries = [{ type: "message", id: "m", message: msg(["closing line"], "FULL ".repeat(40)) }] as any;
    assert.equal(findTerminalReport(entries), "FULL ".repeat(40).trim());
  });
});
