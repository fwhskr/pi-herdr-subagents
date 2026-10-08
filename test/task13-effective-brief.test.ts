import { after, it } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import extension, { __test__ as testApi } from "../pi-extension/subagents/index.ts";
import { __herdrTest__ } from "../pi-extension/subagents/herdr.ts";

const root = mkdtempSync("/home/kris/.pi/agent/var/task13-brief-");
const keys = ["PATH", "HERDR_ENV", "PI_CODING_AGENT_DIR", "PI_SUBAGENT_ID", "PI_DENY_TOOLS", "PI_SUBAGENT_SHELL_READY_DELAY_MS"];
const env = Object.fromEntries(keys.map(key => [key, process.env[key]]));
after(() => {
  for (const key of keys) { if (env[key] == null) delete process.env[key]; else process.env[key] = env[key]; }
  testApi.runningSubagents.clear();
  __herdrTest__.clearCommandAvailability();
  rmSync(root, { recursive: true, force: true });
});

it("no-message resume registers and delivers the same effective brief before launch, exactly once", async () => {
  mkdirSync(join(root, "bin"));
  const herdr = join(root, "bin/herdr");
  writeFileSync(herdr, `#!/usr/bin/env python3
import json, re, shlex, sys
args = sys.argv[1:]
if args[:2] == ['pane', 'list']:
 print(json.dumps({'result': {'type': 'pane_list', 'panes': []}}))
elif args[:2] == ['tab', 'create']:
 print(json.dumps({'result': {'root_pane': {'pane_id': 'child-pane'}}}))
elif args[:2] == ['pane', 'run']:
 text = open(shlex.split(args[3])[1]).read()
 session = re.search(r"PI_SUBAGENT_SESSION='([^']+)'", text).group(1)
 meta = json.load(open(session + '.spawn.json'))
 json.dump(meta, open(session + '.at-launch.json', 'w'))
 with open(session, 'a') as f:
  f.write(json.dumps({'type':'message','message':{'role':'assistant','stopReason':'stop','content':[{'type':'text','text':'current report'}]}}) + '\\n')
 json.dump({'type':'done'}, open(session + '.exit', 'w'))
`);
  chmodSync(herdr, 0o755);
  process.env.PATH = `${join(root, "bin")}:${env.PATH}`;
  process.env.HERDR_ENV = "1";
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "0";
  delete process.env.PI_SUBAGENT_ID;
  delete process.env.PI_DENY_TOOLS;
  __herdrTest__.clearCommandAvailability();
  const child = join(root, "child.jsonl");
  writeFileSync(child, JSON.stringify({ type: "session", version: 3, id: "child-id", cwd: root }) + "\n");
  writeFileSync(`${child}.spawn.json`, JSON.stringify({ task: "original brief", attemptTask: "effective follow-up brief", completionId: "old-attempt", allowance: 0 }));
  const tools = new Map<string, any>();
  const handlers = new Map<string, any>();
  const messages: any[] = [];
  const api: any = {
    on: (name: string, handler: any) => handlers.set(name, handler),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand() {}, registerMessageRenderer() {}, registerShortcut() {}, getAllTools: () => [],
    getThinkingLevel: () => "medium", sendUserMessage() {}, appendEntry() {},
    sendMessage: (message: any) => messages.push(message),
  };
  const ctx: any = {
    cwd: root, hasUI: true, mode: "tui", isProjectTrusted: () => true,
    sessionManager: { getSessionFile: () => join(root, "parent.jsonl"), getSessionId: () => "parent-id", getSessionDir: () => root },
    modelRegistry: { getAvailable: () => [], hasConfiguredAuth: () => true },
    ui: { notify() {}, setWidget() {}, setStatus() {} },
  };
  extension(api);
  handlers.get("session_start")({}, ctx);
  try {
    const result = await tools.get("subagent_resume").execute("resume", { sessionPath: child }, undefined, undefined, ctx);
    const deadline = Date.now() + 5000;
    while (messages.length === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(messages.length, 1, "one current-attempt delivery");
    const registered = JSON.parse(readFileSync(`${child}.at-launch.json`, "utf8"));
    assert.equal(registered.attemptTask, "effective follow-up brief");
    assert.notEqual(registered.completionId, "old-attempt");
    assert.equal(result.details.completionId, registered.completionId);
    assert.equal(result.details.attemptTask, registered.attemptTask);
    assert.equal(messages[0].details.task, registered.attemptTask);
    assert.equal(messages[0].details.completionId, registered.completionId);
    assert.equal(messages[0].details.sessionFile, child);
    assert.match(messages[0].content, /current report/);
    assert.equal(testApi.runningSubagents.size, 0);

    // Freeze a completed attempt while its parent is detached for reload.
    // A later transcript append must not replace the queued attempt's report.
    handlers.get("session_shutdown")({ reason: "reload" }, ctx);
    const next = await tools.get("subagent_resume").execute("next", { sessionPath: child, message: "new brief" }, undefined, undefined, ctx);
    const pending = testApi.runningSubagents.get(next.details.id)!;
    const queuedDeadline = Date.now() + 5000;
    while (pending.lifecycle.process.kind !== "completed" && Date.now() < queuedDeadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(pending.lifecycle.process.kind, "completed", "watcher finished before deferred delivery");
    assert.equal(messages.length, 1, "completion stays queued for its original parent");
    appendFileSync(child, JSON.stringify({ type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "later sibling report" }] } }) + "\n");
    handlers.get("session_start")({}, ctx);
    const deliveryDeadline = Date.now() + 5000;
    while (messages.length < 2 && Date.now() < deliveryDeadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(messages.length, 2);
    assert.equal(messages[1].details.completionId, next.details.completionId);
    assert.equal(messages[1].details.task, "new brief");
    assert.match(messages[1].content, /current report/);
    assert.doesNotMatch(messages[1].content, /later sibling report/);
  } finally { handlers.get("session_shutdown")({ reason: "exit" }, ctx); }
});
