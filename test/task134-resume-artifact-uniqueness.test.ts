import { afterEach, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import subagentsExtension, { __test__ as subagentsTest } from "../pi-extension/subagents/index.ts";
import { __herdrTest__ } from "../pi-extension/subagents/herdr.ts";

// TASK-134: same-name exact-session resumes launched within one clock second
// used to share one prompt artifact (`<name>-<seconds>.md`) and one launch
// script (`<name>-resume-<ms>.sh`). The later write overwrote the earlier, so a
// concurrent attempt could dispatch another attempt's prompt. Each attempt must
// own its prompt and launch script, bound to its own session.
//
// Run: timeout 60 node --test test/task134-resume-artifact-uniqueness.test.ts
// Selectors: "distinct-artifacts"

const ENV_NAMES = [
  "HERDR_ENV", "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID", "PATH",
  "PI_CODING_AGENT_DIR", "PI_SUBAGENT_ID", "PI_DENY_TOOLS", "PI_SUBAGENT_SHELL_READY_DELAY_MS",
  "HERDR_LOG", "HERDR_PANES", "PI_SUBAGENT_AUTO_EXIT", "PI_SUBAGENT_AUTO_EXIT_REARM",
  "PI_SUBAGENT_RESUME_INPUT", "PI_SUBAGENT_SESSION", "PI_SUBAGENT_ACTIVITY_FILE",
  "PI_SUBAGENT_PENDING_CHILD_POLL_MS",
] as const;
const originalEnv = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
const tempRoots = new Set<string>();

afterEach(() => {
  for (const name of ENV_NAMES) {
    const value = originalEnv[name];
    if (value == null) delete process.env[name];
    else process.env[name] = value;
  }
  subagentsTest.runningSubagents.clear();
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
  tempRoots.clear();
  mock.timers.reset();
});

beforeEach(() => {
  delete process.env.PI_SUBAGENT_ID;
  delete process.env.PI_DENY_TOOLS;
});

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function writeJsonl(path: string, entries: object[]): void {
  writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
}

function header(id: string, cwd: string): object {
  return { type: "session", version: 3, id, timestamp: "2026-10-07T23:22:00.000Z", cwd };
}

function fakeHerdr(root: string): void {
  const bin = join(root, "bin");
  const command = join(bin, "herdr");
  mkdirSync(bin, { recursive: true });
  writeFileSync(command, `#!/usr/bin/env python3
import json, os, re, shlex, sys
args = sys.argv[1:]
if args[:2] == ["pane", "list"]:
    print(json.dumps({"result": {"type": "pane_list", "panes": []}}))
elif args[:2] == ["pane", "current"]:
    print(json.dumps({"result": {"pane": {"pane_id": "parent-pane", "tab_id": "parent-tab", "workspace_id": "parent-workspace"}}}))
elif args[:2] == ["tab", "create"]:
    print(json.dumps({"result": {"root_pane": {"pane_id": "new-pane-" + str(os.getpid())}}}))
elif args[:2] == ["pane", "get"]:
    print(json.dumps({"result": {"pane": {"pane_id": args[2], "agent_status": "done"}}}))
elif args[:2] == ["pane", "read"]:
    print("")
elif args[:2] in (["pane", "rename"], ["pane", "report-metadata"], ["pane", "close"], ["pane", "run"]):
    pass
`, "utf8");
  chmodSync(command, 0o755);
  process.env.HERDR_LOG = join(root, "herdr.log");
  writeFileSync(process.env.HERDR_LOG, "", "utf8");
  process.env.PATH = `${bin}:${originalEnv.PATH ?? ""}`;
}

function createApi(parentSession: string, entries: object[]) {
  const handlers = new Map<string, Function[]>();
  const tools: any[] = [];
  const append = (entry: object) => {
    entries.push(entry);
    writeFileSync(parentSession, entries.map((value) => JSON.stringify(value)).join("\n") + "\n", "utf8");
  };
  const api = {
    on(event: string, handler: Function) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerTool(tool: any) { tools.push(tool); },
    registerCommand() {},
    registerMessageRenderer() {},
    registerShortcut() {},
    getAllTools() { return []; },
    getThinkingLevel() { return "medium"; },
    sendUserMessage() {},
    sendMessage(message: any) {
      append({ type: "custom_message", id: `custom-${entries.length}`, customType: message.customType, content: message.content, display: message.display, details: message.details });
    },
    appendEntry(type: string, data: object) {
      append({ type: "custom", id: `entry-${entries.length}`, customType: type, data });
    },
  } as any;
  return {
    api,
    handlers,
    tools,
    ctx: {
      cwd: process.cwd(),
      hasUI: true,
      mode: "tui",
      model: { provider: "fake", id: "parent" },
      modelRegistry: {
        find: () => ({ provider: "fake", id: "parent", reasoning: true }),
        getAvailable: () => [],
        hasConfiguredAuth: () => true,
      },
      sessionManager: {
        getSessionFile: () => parentSession,
        getSessionId: () => "parent-id",
        getSessionDir: () => join(parentSession, ".."),
      },
      ui: { notify() {}, setWidget() {} },
    } as any,
  };
}

describe("TASK-134 same-name concurrent resumes keep per-attempt artifacts", () => {
  it("distinct-artifacts: three same-name resumes in one frozen second get their own prompt and script", { timeout: 20_000 }, async () => {
    mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-08T14:00:00.250Z").getTime() });
    const root = mkdtempSync(join(tmpdir(), "task134-resume-"));
    tempRoots.add(root);
    fakeHerdr(root);
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "parent-pane";
    process.env.HERDR_TAB_ID = "parent-tab";
    process.env.HERDR_WORKSPACE_ID = "parent-workspace";
    process.env.PI_CODING_AGENT_DIR = join(root, "agent");
    process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "0";
    __herdrTest__.clearCommandAvailability();

    const parent = join(root, "parent.jsonl");
    const entries: object[] = [header("parent-id", root)];
    writeJsonl(parent, entries);

    const attempts = ["TASK-A", "TASK-B", "TASK-C"].map((label) => {
      const cwd = join(root, `cwd-${label}`);
      mkdirSync(cwd, { recursive: true });
      const child = join(root, `${label}.jsonl`);
      writeJsonl(child, [header(`child-${label}`, cwd)]);
      return { label, child, message: `Task name: ${label}\nprompt body for ${label}` };
    });

    const built = createApi(parent, entries);
    built.ctx.cwd = root;
    subagentsExtension(built.api);
    built.handlers.get("session_start")?.[0]({}, built.ctx);
    const tool = built.tools.find((candidate) => candidate.name === "subagent_resume");
    assert.ok(tool, "subagent_resume tool registered");

    for (const attempt of attempts) {
      const result = await tool.execute(
        `task134-${attempt.label}`,
        { name: "artist", sessionPath: attempt.child, message: attempt.message, autoExit: true },
        undefined, undefined, built.ctx,
      );
      assert.equal(result.details.status, "started", JSON.stringify(result.details));
      assert.ok(typeof result.details.promptFile === "string", "receipt names the prompt file");
      assert.equal(result.details.promptSha256, sha256(attempt.message), "receipt names the effective prompt hash");
      assert.equal(statSync(result.details.promptFile).mode & 0o222, 0, "prompt artifact is immutable");
      assert.equal(readFileSync(result.details.promptFile, "utf8"), attempt.message, "receipt prompt file holds the attempt's own message");
    }

    const scriptDir = join(root, "artifacts", "parent-id", "subagent-scripts");
    const scripts = readdirSync(scriptDir).filter((file) =>
      readFileSync(join(scriptDir, file), "utf8").includes("Subagent resume script"),
    );
    assert.equal(scripts.length, attempts.length, `one launch script per attempt, found: ${scripts.join(", ")}`);

    const promptPaths = new Set<string>();
    for (const attempt of attempts) {
      const matching = scripts.filter((file) => readFileSync(join(scriptDir, file), "utf8").includes(`PI_SUBAGENT_SESSION='${attempt.child}'`));
      assert.equal(matching.length, 1, `exactly one launch script bound to ${attempt.label}`);
      const script = readFileSync(join(scriptDir, matching[0]), "utf8");
      const promptMatch = script.match(/@(\S*subagent-resume\/[^'\s]+\.md)/);
      assert.ok(promptMatch, `script for ${attempt.label} references its prompt file:\n${script.slice(0, 400)}`);
      const promptFile = promptMatch[1];
      promptPaths.add(promptFile);
      assert.equal(readFileSync(promptFile, "utf8"), attempt.message, `prompt file for ${attempt.label} must hold only its own message`);
    }
    assert.equal(promptPaths.size, attempts.length, "each attempt owns a distinct prompt artifact");
  });
});

describe("TASK-134 explicit task requests are checked against the retained session binding", () => {
  it("binding-refusal: a request naming another lane's task is refused before dispatch; matching concurrent resumes succeed", { timeout: 20_000 }, async () => {
    mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-08T14:00:00.250Z").getTime() });
    const root = mkdtempSync(join(tmpdir(), "task134-binding-"));
    tempRoots.add(root);
    fakeHerdr(root);
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "parent-pane";
    process.env.HERDR_TAB_ID = "parent-tab";
    process.env.HERDR_WORKSPACE_ID = "parent-workspace";
    process.env.PI_CODING_AGENT_DIR = join(root, "agent");
    process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "0";
    __herdrTest__.clearCommandAvailability();

    const parent = join(root, "parent.jsonl");
    const entries: object[] = [header("parent-id", root)];
    writeJsonl(parent, entries);

    const lanes = ["136.21", "152.5", "136.24"].map((lane) => {
      const cwd = join(root, ".worktrees", `task-${lane}`);
      mkdirSync(cwd, { recursive: true });
      const child = join(root, `lane-${lane}.jsonl`);
      writeJsonl(child, [header(`child-${lane}`, cwd)]);
      return { lane, cwd, child };
    });

    const built = createApi(parent, entries);
    built.ctx.cwd = root;
    subagentsExtension(built.api);
    built.handlers.get("session_start")?.[0]({}, built.ctx);
    const tool = built.tools.find((candidate) => candidate.name === "subagent_resume");
    assert.ok(tool, "subagent_resume tool registered");

    const [accounts, statistics, dashboard] = lanes;
    const refused = await tool.execute(
      "task134-mismatch",
      { name: "artist", sessionPath: accounts.child, message: "Task name: TASK-152.5\nstatistics brief", autoExit: true },
      undefined, undefined, built.ctx,
    );
    assert.equal(refused.details.status, "refused", JSON.stringify(refused.details));
    assert.equal(refused.details.requestedTask, "TASK-152.5");
    assert.equal(refused.details.retainedTask, "TASK-136.21");
    assert.match(refused.content[0].text, /TASK-152\.5/);
    assert.match(refused.content[0].text, /TASK-136\.21/);

    const scriptDir = join(root, "artifacts", "parent-id", "subagent-scripts");
    const scriptsFor = (session: string) => (existsSync(scriptDir) ? readdirSync(scriptDir) : []).filter((file) =>
      readFileSync(join(scriptDir, file), "utf8").includes(`PI_SUBAGENT_SESSION='${session}'`),
    );
    assert.equal(scriptsFor(accounts.child).length, 0, "refused request launched nothing");

    const results = await Promise.all([
      tool.execute("task134-stat", { name: "artist", sessionPath: statistics.child, message: "Task name: TASK-152.5\nstatistics brief", autoExit: true }, undefined, undefined, built.ctx),
      tool.execute("task134-dash", { name: "artist", sessionPath: dashboard.child, message: "Task name: TASK-136.24\ndashboard brief", autoExit: true }, undefined, undefined, built.ctx),
    ]);
    for (const result of results) assert.equal(result.details.status, "started", JSON.stringify(result.details));
    assert.equal(scriptsFor(statistics.child).length, 1, "matching resume launches exactly once");
    assert.equal(scriptsFor(dashboard.child).length, 1, "independent matching resume launches exactly once");
  });
});
describe("TASK-134 same-name resume orderings keep each attempt's binding", () => {
  it("orderings: three same-name concurrent resumes in every start order each receive their own prompt, then serial success", { timeout: 40_000 }, async () => {
    const orders = [[0, 1, 2], [2, 1, 0], [1, 2, 0]];
    for (const order of orders) {
      mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-08T14:00:00.250Z").getTime() });
      const root = mkdtempSync(join(tmpdir(), "task134-order-"));
      tempRoots.add(root);
      fakeHerdr(root);
      process.env.HERDR_ENV = "1";
      process.env.HERDR_PANE_ID = "parent-pane";
      process.env.HERDR_TAB_ID = "parent-tab";
      process.env.HERDR_WORKSPACE_ID = "parent-workspace";
      process.env.PI_CODING_AGENT_DIR = join(root, "agent");
      process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "0";
      __herdrTest__.clearCommandAvailability();

      const parent = join(root, "parent.jsonl");
      const entries: object[] = [header("parent-id", root)];
      writeJsonl(parent, entries);
      const attempts = ["ORD-A", "ORD-B", "ORD-C", "ORD-D"].map((label) => {
        const cwd = join(root, `cwd-${label}`);
        mkdirSync(cwd, { recursive: true });
        const child = join(root, `${label}.jsonl`);
        writeJsonl(child, [header(`child-${label}`, cwd)]);
        return { label, child, message: `Task name: ${label}\nbody for ${label} in order ${order.join("")}` };
      });

      const built = createApi(parent, entries);
      built.ctx.cwd = root;
      subagentsExtension(built.api);
      built.handlers.get("session_start")?.[0]({}, built.ctx);
      const tool = built.tools.find((candidate) => candidate.name === "subagent_resume");
      assert.ok(tool, "subagent_resume tool registered");

      // Start three concurrent attempts in the given order; the fourth runs serially afterwards.
      const concurrent = order.map((index) => {
        const attempt = attempts[index];
        return tool.execute(`ord-${attempt.label}`, { name: "artist", sessionPath: attempt.child, message: attempt.message, autoExit: true }, undefined, undefined, built.ctx)
          .then((result: any) => ({ attempt, result }));
      });
      const settled = await Promise.all(concurrent);
      for (const { attempt, result } of settled) {
        assert.equal(result.details.status, "started", `order ${order.join("")} ${attempt.label}: ${JSON.stringify(result.details)}`);
        assert.equal(result.details.promptSha256, sha256(attempt.message), `order ${order.join("")} ${attempt.label}: receipt hash is its own prompt`);
        assert.equal(readFileSync(result.details.promptFile, "utf8"), attempt.message, `order ${order.join("")} ${attempt.label}: prompt file is its own`);
      }
      assert.equal(new Set(settled.map(({ result }) => result.details.promptFile)).size, 3, "three distinct prompt artifacts");

      const serial = await tool.execute("ord-serial", { name: "artist", sessionPath: attempts[3].child, message: attempts[3].message, autoExit: true }, undefined, undefined, built.ctx);
      assert.equal(serial.details.status, "started", JSON.stringify(serial.details));
      assert.equal(readFileSync(serial.details.promptFile, "utf8"), attempts[3].message, "serial attempt keeps its own prompt");
      mock.timers.reset();
    }
  });
});

describe("TASK-134 receipts name the exact dispatched target and prompt", () => {
  it("receipt-target: each receipt names its own session, attempt task, prompt file and prompt hash, never another brief", { timeout: 20_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "task134-receipt-"));
    tempRoots.add(root);
    fakeHerdr(root);
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "parent-pane";
    process.env.HERDR_TAB_ID = "parent-tab";
    process.env.HERDR_WORKSPACE_ID = "parent-workspace";
    process.env.PI_CODING_AGENT_DIR = join(root, "agent");
    process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "0";
    __herdrTest__.clearCommandAvailability();

    const parent = join(root, "parent.jsonl");
    const entries: object[] = [header("parent-id", root)];
    writeJsonl(parent, entries);
    const attempts = ["RCPT-A", "RCPT-B", "RCPT-C"].map((label) => {
      const cwd = join(root, `cwd-${label}`);
      mkdirSync(cwd, { recursive: true });
      const child = join(root, `${label}.jsonl`);
      writeJsonl(child, [header(`child-${label}`, cwd)]);
      return { label, child, message: `Task name: TASK-${label}\nbrief for ${label}` };
    });

    const built = createApi(parent, entries);
    built.ctx.cwd = root;
    subagentsExtension(built.api);
    built.handlers.get("session_start")?.[0]({}, built.ctx);
    const tool = built.tools.find((candidate) => candidate.name === "subagent_resume");
    assert.ok(tool, "subagent_resume tool registered");

    const results = await Promise.all(attempts.map((attempt) =>
      tool.execute(`rcpt-${attempt.label}`, { name: "artist", sessionPath: attempt.child, message: attempt.message, autoExit: true }, undefined, undefined, built.ctx),
    ));
    results.forEach((result, index) => {
      const attempt = attempts[index];
      const d = result.details;
      assert.equal(d.status, "started", JSON.stringify(d));
      assert.equal(d.sessionPath, attempt.child, "receipt names the dispatched session");
      assert.ok(String(d.attemptTask).includes(`Task name: TASK-${attempt.label}`), "receipt names the attempt task");
      assert.equal(d.promptSha256, sha256(attempt.message), "receipt hash is the effective prompt");
      assert.equal(sha256(readFileSync(d.promptFile, "utf8")), d.promptSha256, "named prompt file hashes to the receipt hash");
      const script = readFileSync(d.launchScriptFile, "utf8");
      assert.ok(script.includes(`PI_SUBAGENT_SESSION='${attempt.child}'`), "launch script targets the receipt session");
      assert.ok(script.includes(d.promptFile), "launch script dispatches the receipt prompt file");
      for (const other of attempts) {
        if (other !== attempt) assert.ok(!result.content[0].text.includes(other.label) && !script.includes(other.child), "ACK carries no other attempt's binding");
      }
    });
  });
});

describe("TASK-134 independent resumes are not globally serialized", () => {
  it("no-global-lock: resumes of distinct sessions overlap their launch window; only the same session is refused", { timeout: 20_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "task134-lock-"));
    tempRoots.add(root);
    fakeHerdr(root);
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "parent-pane";
    process.env.HERDR_TAB_ID = "parent-tab";
    process.env.HERDR_WORKSPACE_ID = "parent-workspace";
    process.env.PI_CODING_AGENT_DIR = join(root, "agent");
    const delayMs = 400;
    process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = String(delayMs);
    __herdrTest__.clearCommandAvailability();

    const parent = join(root, "parent.jsonl");
    const entries: object[] = [header("parent-id", root)];
    writeJsonl(parent, entries);
    const sessions = ["LOCK-A", "LOCK-B", "LOCK-C"].map((label) => {
      const cwd = join(root, `cwd-${label}`);
      mkdirSync(cwd, { recursive: true });
      const child = join(root, `${label}.jsonl`);
      writeJsonl(child, [header(`child-${label}`, cwd)]);
      return child;
    });

    const built = createApi(parent, entries);
    built.ctx.cwd = root;
    subagentsExtension(built.api);
    built.handlers.get("session_start")?.[0]({}, built.ctx);
    const tool = built.tools.find((candidate) => candidate.name === "subagent_resume");
    assert.ok(tool, "subagent_resume tool registered");

    // Record each launch window (the shell-ready delay that precedes a resume launch)
    // as a start and an end event. Ends are held until all three launches have started,
    // so the event order reflects scheduling only, not CPU load.
    const launchEvents: string[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const held: Array<() => void> = [];
    const releaseHeld = () => {
      while (held.length > 0) held.shift()?.();
    };
    const timerSpy = ((handler: (...args: unknown[]) => void, timeout?: number, ...args: unknown[]) => {
      if (timeout !== delayMs) return realSetTimeout(handler, timeout, ...args);
      launchEvents.push("start");
      held.push(() => {
        launchEvents.push("end");
        handler(...args);
      });
      if (held.length === sessions.length) realSetTimeout(releaseHeld, 0);
      else realSetTimeout(releaseHeld, 10_000);
      return realSetTimeout(() => {}, 0);
    }) as typeof globalThis.setTimeout;
    let results: Awaited<ReturnType<typeof tool.execute>>[];
    globalThis.setTimeout = timerSpy;
    try {
      results = await Promise.all(sessions.map((sessionPath, index) =>
        tool.execute(`lock-${index}`, { name: "artist", sessionPath, message: `Task name: TASK-LOCK-${index}\nbrief`, autoExit: true }, undefined, undefined, built.ctx),
      ));
    } finally {
      globalThis.setTimeout = realSetTimeout;
      releaseHeld();
    }
    for (const result of results) assert.equal(result.details.status, "started", JSON.stringify(result.details));
    // Three launch windows overlap iff every start precedes the first end; a global lock would
    // run them back to back (start, end, start, end, ...).
    const starts = launchEvents.filter((event) => event === "start").length;
    const firstEnd = launchEvents.indexOf("end");
    const lastStart = launchEvents.lastIndexOf("start");
    assert.equal(starts, sessions.length, `each distinct session opened one launch window (events ${launchEvents.join(",")})`);
    assert.ok(lastStart < firstEnd, `distinct sessions overlapped their launch window (events ${launchEvents.join(",")})`);

    const fourth = join(root, "LOCK-D.jsonl");
    writeJsonl(fourth, [header("child-LOCK-D", root)]);
    const sameSession = await Promise.all([
      tool.execute("same-a", { name: "artist", sessionPath: fourth, message: "Task name: TASK-LOCK-D\nagain", autoExit: true }, undefined, undefined, built.ctx),
      tool.execute("same-b", { name: "artist", sessionPath: fourth, message: "Task name: TASK-LOCK-D\nagain", autoExit: true }, undefined, undefined, built.ctx),
    ]);
    assert.deepEqual(sameSession.map((result) => result.details.status).sort(), ["refused", "started"], "only the exact same session is guarded");
  });
});
