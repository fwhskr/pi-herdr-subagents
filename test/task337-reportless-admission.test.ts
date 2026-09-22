/**
 * TASK-337 — reject or classify reportless subagent completion before
 * admitting `completed`.
 *
 * Confirmed defect (TASK-236 AC1 diagnosis, parent session bebb6cee:513/773):
 * a child that calls `subagent_done` with no report and exits 0 was admitted
 * as `completed` and rendered to the parent as
 *
 *   Sub-agent "general" completed (3m 48s). ...
 *   Sub-agent exited without output
 *
 * because `watchSubagent` chose the lifecycle from `result.exitCode` alone.
 * These fixtures drive the REAL production watcher against a real
 * `<session>.exit` sidecar and assert:
 *   AC1  a reportless completion is NOT admitted as completed; it carries an
 *        explicit failure kind naming the absence.
 *   AC2  a same-message final text report or a `subagent_done` report argument
 *        is still admitted exactly as today, with that text as the summary.
 *   AC4  the new reportless failure carries the captured stderr tail and the
 *        persisted pane-scrollback reference when available.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as subagentsModule from "../pi-extension/subagents/index.ts";
import subagentsExtension from "../pi-extension/subagents/index.ts";
import { createLifecycle } from "../pi-extension/subagents/lifecycle.ts";

const testApi = (subagentsModule as any).__test__;

const createdDirs: string[] = [];
function createDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "subagents-t337-"));
  createdDirs.push(dir);
  return dir;
}

// Keep the watcher isolated from inherited parent/child identity variables.
const inheritedSubagentId = process.env.PI_SUBAGENT_ID;
const inheritedDenyTools = process.env.PI_DENY_TOOLS;
const inheritedActivityFile = process.env.PI_SUBAGENT_ACTIVITY_FILE;
before(() => {
  delete process.env.PI_SUBAGENT_ID;
  delete process.env.PI_DENY_TOOLS;
  delete process.env.PI_SUBAGENT_ACTIVITY_FILE;
});
after(() => {
  if (inheritedSubagentId == null) delete process.env.PI_SUBAGENT_ID;
  else process.env.PI_SUBAGENT_ID = inheritedSubagentId;
  if (inheritedDenyTools == null) delete process.env.PI_DENY_TOOLS;
  else process.env.PI_DENY_TOOLS = inheritedDenyTools;
  if (inheritedActivityFile == null) delete process.env.PI_SUBAGENT_ACTIVITY_FILE;
  else process.env.PI_SUBAGENT_ACTIVITY_FILE = inheritedActivityFile;
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true });
});

/** The exact parent-visible shape observed in the two 2026-09-17 incidents. */
const REPORTLESS_ASSISTANT = {
  type: "message",
  id: "assistant-reportless",
  parentId: "root",
  timestamp: "2026-09-17T21:13:00.000Z",
  message: {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "done" },
      { type: "toolCall", toolName: "subagent_done", toolCallId: "tc-done", arguments: {} },
    ],
    stopReason: "toolUse",
  },
};

const REPORT_TEXT_ASSISTANT = {
  type: "message",
  id: "assistant-text",
  parentId: "root",
  timestamp: "2026-09-17T21:13:00.000Z",
  message: {
    role: "assistant",
    content: [
      { type: "text", text: "Task complete: wrote the report." },
      { type: "toolCall", toolName: "subagent_done", toolCallId: "tc-done", arguments: {} },
    ],
    stopReason: "toolUse",
  },
};

const REPORT_ARG_ASSISTANT = {
  type: "message",
  id: "assistant-arg",
  parentId: "root",
  timestamp: "2026-09-17T21:13:00.000Z",
  message: {
    role: "assistant",
    content: [
      { type: "toolCall", toolName: "subagent_done", toolCallId: "tc-done", arguments: { report: "Report via arg" } },
    ],
    stopReason: "toolUse",
  },
};

interface WatchOptions {
  entries: object[];
  stderrFile?: string;
  artifactDir?: string;
  paneScrollback?: any;
}

async function runWatcher(dir: string, options: WatchOptions) {
  const sessionFile = join(dir, "child.jsonl");
  writeFileSync(sessionFile, options.entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  // A clean `done` sidecar with no error message: exitCode 0, nothing else.
  writeFileSync(`${sessionFile}.exit`, JSON.stringify({ type: "done" }));
  const startTime = Date.now() - 3_000;
  return await testApi.watchSubagent(
    {
      id: "t337-child",
      name: "general",
      task: "t337",
      surface: "pane-t337",
      startTime,
      sessionFile,
      ...(options.stderrFile ? { stderrFile: options.stderrFile } : {}),
      ...(options.artifactDir ? { artifactDir: options.artifactDir } : {}),
      ...(options.paneScrollback ? { paneScrollback: options.paneScrollback } : {}),
      interactive: false,
      lifecycle: createLifecycle(startTime),
    },
    new AbortController().signal,
  );
}

describe("TASK-337 reportless completion admission", () => {
  it("does NOT admit a reportless done as completed and names the absence (red-first parent-visible shape)", async () => {
    const dir = createDir();
    const result = await runWatcher(dir, { entries: [REPORTLESS_ASSISTANT] });
    const presentation = testApi.resolveResultPresentation(result, "general");

    // The exact incident string must never be produced by an admitted-completed path.
    assert.doesNotMatch(
      presentation,
      /completed \(3s\)\.\n\nSub-agent exited without output/,
      "reportless completion must not render as completed + 'exited without output'",
    );
    assert.equal(result.failureKind, "reportless");
    assert.match(presentation, /without a terminal report/i);
    assert.match(presentation, /no assistant final text/i);
    assert.doesNotMatch(presentation, /\bcompleted\b/i);
  });

  it("preserves a same-message final text report as an admitted completion", async () => {
    const dir = createDir();
    const result = await runWatcher(dir, { entries: [REPORT_TEXT_ASSISTANT] });
    assert.equal(result.failureKind, undefined);
    assert.equal(result.summary, "Task complete: wrote the report.");
    const presentation = testApi.resolveResultPresentation(result, "general");
    assert.match(presentation, /completed \(3s\)\.\n\nTask complete: wrote the report\./);
  });

  it("preserves a subagent_done report argument as an admitted completion", async () => {
    const dir = createDir();
    const result = await runWatcher(dir, { entries: [REPORT_ARG_ASSISTANT] });
    assert.equal(result.failureKind, undefined);
    assert.equal(result.summary, "Report via arg");
    const presentation = testApi.resolveResultPresentation(result, "general");
    assert.match(presentation, /completed \(3s\)\.\n\nReport via arg/);
  });

  it("treats a whitespace-only report with no other text as reportless", async () => {
    const dir = createDir();
    const whitespace = {
      type: "message",
      id: "assistant-ws",
      parentId: "root",
      timestamp: "2026-09-17T21:13:00.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", toolName: "subagent_done", toolCallId: "tc-done", arguments: { report: "   " } },
        ],
        stopReason: "toolUse",
      },
    };
    const result = await runWatcher(dir, { entries: [whitespace] });
    assert.equal(result.failureKind, "reportless");
    const presentation = testApi.resolveResultPresentation(result, "general");
    assert.doesNotMatch(presentation, /\bcompleted\b/i);
  });

  it("classifies an exit-0 done with no session file as reportless, not completed", async () => {
    const dir = createDir();
    const sessionFile = join(dir, "never-created.jsonl");
    writeFileSync(`${sessionFile}.exit`, JSON.stringify({ type: "done" }));
    const startTime = Date.now() - 3_000;
    const result = await testApi.watchSubagent(
      {
        id: "t337-missing",
        name: "general",
        task: "t337",
        surface: "pane-t337",
        startTime,
        sessionFile,
        interactive: false,
        lifecycle: createLifecycle(startTime),
      },
      new AbortController().signal,
    );
    assert.equal(result.failureKind, "reportless");
    const presentation = testApi.resolveResultPresentation(result, "general");
    assert.doesNotMatch(presentation, /\bcompleted\b/i);
    assert.match(presentation, /without a terminal report/i);
  });

  it("attaches the captured stderr tail on a reportless failure", async () => {
    const dir = createDir();
    const stderrFile = join(dir, "child.stderr.log");
    writeFileSync(stderrFile, "Error: Failed to load extension /missing/subagent-done.ts\n");
    const result = await runWatcher(dir, { entries: [REPORTLESS_ASSISTANT], stderrFile });
    assert.equal(result.failureKind, "reportless");
    assert.equal(result.stderr.tail, "Error: Failed to load extension /missing/subagent-done.ts\n");
    const presentation = testApi.resolveResultPresentation(result, "general");
    assert.match(presentation, /Child stderr/);
    assert.match(presentation, /Failed to load extension/);
  });

  it("attaches the persisted pane-scrollback reference on a reportless failure", async () => {
    const dir = createDir();
    const ref = {
      path: join(dir, "pane-scrollback", "t337-child-pane-t337.log"),
      bytes: 42,
      sha256: "a".repeat(64),
      source: "recent-unwrapped",
      readLines: 10_000,
      truncated: false,
    };
    const result = await runWatcher(dir, { entries: [REPORTLESS_ASSISTANT], paneScrollback: ref });
    assert.equal(result.failureKind, "reportless");
    const presentation = testApi.resolveResultPresentation(result, "general");
    assert.match(presentation, /Pane scrollback persisted:/);
    assert.match(presentation, new RegExp(ref.sha256));
  });

  it("labels a reportless exit-0 completion as failed (no report) in the message renderer", () => {
    const registeredMessageRenderers: Array<any> = [];
    const api = {
      on() {},
      registerTool() {},
      registerCommand() {},
      registerMessageRenderer(name: string, renderer: any) {
        registeredMessageRenderers.push({ name, renderer });
      },
      registerShortcut() {},
      sendUserMessage() {},
      sendMessage() {},
      getAllTools() {
        return [];
      },
    } as any;
    subagentsExtension(api);
    const entry = registeredMessageRenderers.find((e) => e.name === "subagent_result");
    assert.ok(entry, "expected the subagent_result renderer to be registered");
    const theme = {
      fg: (_color: string, text: string) => text,
      bg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    };
    const rendered = entry.renderer(
      {
        customType: "subagent_result",
        content:
          'Sub-agent "general" exited without a terminal report after 3s.\n\n' +
          "Sub-agent exited successfully but produced no terminal report.",
        details: {
          name: "general",
          exitCode: 0,
          elapsed: 3,
          failureKind: "reportless",
          sessionFile: "/tmp/child.jsonl",
        },
      },
      { expanded: true },
      theme,
    );
    const text = rendered.render(80).join("\n");
    assert.match(text, /failed \(no report\)/);
    assert.doesNotMatch(text, /completed/);
  });

  it("does not classify a ping as reportless", async () => {
    const dir = createDir();
    const sessionFile = join(dir, "child.jsonl");
    writeFileSync(sessionFile, JSON.stringify(REPORTLESS_ASSISTANT) + "\n");
    writeFileSync(`${sessionFile}.exit`, JSON.stringify({ type: "ping", name: "general", message: "need help" }));
    const startTime = Date.now() - 3_000;
    const result = await testApi.watchSubagent(
      {
        id: "t337-ping",
        name: "general",
        task: "t337",
        surface: "pane-t337",
        startTime,
        sessionFile,
        interactive: false,
        lifecycle: createLifecycle(startTime),
      },
      new AbortController().signal,
    );
    assert.equal(result.failureKind, undefined);
    assert.ok(result.ping);
  });
});
