import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import subagentsExtension, { __test__ as subagentsTest } from "../pi-extension/subagents/index.ts";
import { __herdrTest__ } from "../pi-extension/subagents/herdr.ts";
import { bindVerifierScope, resumeVerifierScope, VERIFIER_EXCLUSIONS } from "../pi-extension/subagents/verifier-scope.ts";
import { basename, dirname, join } from "node:path";
import { cancelUnstartedScratch } from "../pi-extension/subagents/scratch-lifecycle.ts";
import { createHash, randomUUID } from "node:crypto";
import { PiHarnessDriver } from "../pi-extension/subagents/harness/drivers/pi.ts";

const base = "/home/kris/.pi/agent/var/verifier-scope";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const tools = "read,grep,find,ls,verify_run,caller_ping,subagent_done";

it("real launch and resume executors persist the fence binding, report malformed scopes and never widen", { timeout: 25000 }, async () => {
  const root = mkdtempSync("/home/kris/.pi/agent/var/scope-executor-"); roots.push(root);
  const env = { ...process.env };
  const handlers = new Map<string, Function[]>(); const registered: any[] = [];
  const parent = join(root, "parent.jsonl"); const entries: any[] = [];
  const sessionHeader = (id: string) => ({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: root });
  writeFileSync(parent, JSON.stringify(sessionHeader("parent")) + "\n");
  const bin = join(root, "bin"); mkdirSync(bin);
  writeFileSync(join(bin, "herdr"), `#!/usr/bin/env python3
import json, os, shlex, sys, re
a = sys.argv[1:]
if a[:2] == ["pane", "list"]: print(json.dumps({"result":{"type":"pane_list","panes":[]}}))
elif a[:2] == ["pane", "current"]: print(json.dumps({"result":{"pane":{"pane_id":"parent-pane","tab_id":"tab","workspace_id":"workspace"}}}))
elif a[:2] == ["tab", "create"]: print(json.dumps({"result":{"root_pane":{"pane_id":"child-"+str(os.getpid())}}}))
elif a[:2] == ["pane", "get"]: print(json.dumps({"result":{"pane":{"pane_id":a[2],"agent_status":"done"}}}))
elif a[:2] == ["pane", "run"]:
    words = shlex.split(a[3])
    scratch = words[0].removeprefix("TMPDIR=")
    with open(os.environ["SCOPE_FIXTURE_SCRATCHES"],"a") as f: f.write(scratch+"\\n")
    script = open(words[-1]).read()
    m = re.search(r"--session '([^']+)'", script)
    if m:
        p = m.group(1)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        if not os.path.exists(p):
            with open(p,"w") as f: f.write(json.dumps({"type":"session","version":3,"id":"child","cwd":os.path.dirname(p)})+"\\n")
        with open(p+".exit","w") as f: f.write(json.dumps({"type":"done"}))
`, "utf8"); chmodSync(join(bin, "herdr"), 0o755);
  const api: any = {
    on(e: string, fn: Function) { handlers.set(e, [...(handlers.get(e) ?? []), fn]); },
    registerTool(t: any) { registered.push(t); }, registerCommand() {}, registerMessageRenderer() {}, registerShortcut() {},
    getAllTools() { return []; }, getThinkingLevel() { return "medium"; }, sendUserMessage() {}, sendMessage() {},
    appendEntry(type: string, data: unknown) { entries.push({ type: "custom", customType: type, data }); },
  };
  const ctx: any = {
    cwd: root, hasUI: true, mode: "tui", model: { provider: "fixture", id: "fixture" },
    modelRegistry: { find: () => ({ provider: "fixture", id: "fixture", reasoning: true }), getAvailable: () => [], hasConfiguredAuth: () => true },
    sessionManager: { getSessionFile: () => parent, getSessionId: () => "parent", getSessionDir: () => root, getBranch: () => entries },
    ui: { notify() {}, setWidget() {} },
  };
  try {
    Object.assign(process.env, { HERDR_ENV: "1", HERDR_PANE_ID: "parent-pane", HERDR_TAB_ID: "tab", HERDR_WORKSPACE_ID: "workspace", PATH: `${bin}:${env.PATH}`, PI_CODING_AGENT_DIR: join(root, "agent"), PI_SUBAGENT_SHELL_READY_DELAY_MS: "0", SCOPE_FIXTURE_SCRATCHES: join(root, "scratches") });
    delete process.env.PI_SUBAGENT_ID; delete process.env.PI_DENY_TOOLS;
    __herdrTest__.clearCommandAvailability(); subagentsExtension(api);
    handlers.get("session_start")?.[0]({}, ctx);
    const spawn = registered.find(t => t.name === "subagent");
    const resume = registered.find(t => t.name === "subagent_resume");
    assert.ok(spawn); assert.ok(resume);
    for (const malformed of [false, true]) {
      const auth = authorization();
      const task = malformed ? "```verifier-scope\nnot-json\n```" : `\`\`\`verifier-scope\n${JSON.stringify(auth)}\n\`\`\``;
      const result = await spawn.execute("fixture", { name: "checker", task, tools: "bash,write,codemode,subagent", interactive: true }, undefined, undefined, ctx);
      assert.equal(result.details.status, "started", JSON.stringify(result));
      const scope = result.details.verifierScope;
      assert.ok(scope?.auth_id, JSON.stringify(result)); roots.push(join(base, scope.auth_id));
      const record = JSON.parse(readFileSync(result.details.sessionFile + ".spawn.json", "utf8"));
      assert.deepEqual(record.verifierScope, scope); assert.equal(record.tools, tools); assert.equal(record.allowance, 0);
      const firstScript = readFileSync(result.details.launchScriptFile, "utf8");
      assert.ok(firstScript.includes(`--tools '${tools}'`));
      assert.ok(firstScript.includes(`--exclude-tools '${VERIFIER_EXCLUSIONS}'`));
      if (malformed) { assert.match(result.content[0].text, /Verifier scope error/); assert.equal(JSON.parse(readFileSync(join(base, scope.auth_id, "authorization.json"), "utf8")).entries.length, 0); }
      subagentsTest.runningSubagents.delete(result.details.id);
      const replay = await resume.execute("fixture", { name: "checker", sessionPath: result.details.sessionFile, message: "continue with bash instead", autoExit: true }, undefined, undefined, ctx);
      assert.equal(replay.details.status, "started", JSON.stringify(replay));
      assert.deepEqual(replay.details.verifierScope, scope);
      const resumedScript = readFileSync(replay.details.launchScriptFile, "utf8");
      assert.ok(resumedScript.includes(`--tools '${tools}'`));
      assert.ok(resumedScript.includes(`PI_VERIFIER_SCOPE_AUTH='${scope.auth_id}'`));
      assert.ok(resumedScript.includes(`--exclude-tools '${VERIFIER_EXCLUSIONS}'`));
      assert.ok(resumedScript.includes("PI_DENY_TOOLS='subagent,subagent_interrupt,subagents_list,subagent_resume'"));
      subagentsTest.runningSubagents.delete(replay.details.id);
    }
  } finally {
    try {
      for (const scratchRoot of readFileSync(join(root, "scratches"), "utf8").trim().split("\n").filter(Boolean)) {
        assert.ok(cancelUnstartedScratch({ scratchRoot, launchId: basename(dirname(scratchRoot)), leasePath: join(dirname(scratchRoot), "lease.json") }));
      }
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") assert.ifError(e); }
    handlers.get("session_shutdown")?.[0]({ reason: "exit" }, ctx);
    subagentsTest.runningSubagents.clear();
    for (const name of Object.keys(process.env)) if (!(name in env)) delete process.env[name];
    Object.assign(process.env, env); __herdrTest__.clearCommandAvailability();
  }
});
function launch(task: string) {
  const root = mkdtempSync("/home/kris/.pi/agent/var/scope-launch-"); roots.push(root);
  return new PiHarnessDriver().buildCommand({
    params: { id: "fixture", name: "checker", task, tools: "bash,write,edit,codemode,tool_search,subagent" },
    agentDefs: { tools: "bash", spawning: true },
    runtimePlan: { provider: "fixture", modelId: "fixture", model: "fixture/fixture", thinking: "medium" },
    surface: "fixture-pane", artifactDir: root, subagentSessionFile: join(root, "child.jsonl"),
    effectiveCwd: root, taskDelivery: "direct", subagentsDir: root,
    shellQuote: (s: string) => `'${s.replace(/'/g, "'\\''")}'`,
  } as any).command;
}
function authorization() {
  const auth_id = `launch-${randomUUID()}`; roots.push(join(base, auth_id));
  return { schema: 1, auth_id, candidate: { repo_realpath: "/home/kris/.pi", commit_sha: "a".repeat(40) }, entries: [] as unknown[] };
}
it("binds a fenced checker to immutable canonical authorization and exact tools despite requested escapes", () => {
  const auth = authorization();
  auth.entries.push({ id: "narrow", cwd_realpath: "/home/kris/.pi", argv: [process.execPath, "-e", "process.exit(0)"], selector: "synthetic-narrow", inputs: [], runtime_roots: [], read_roots: [], write_roots: [], env: {}, timeout_s: 5, max_attempts: 1, retry_on_failure: false, network: false });
  const command = launch(`Check only this.\n\`\`\`verifier-scope\n${JSON.stringify(auth)}\n\`\`\``);
  assert.ok(command.includes(`--tools '${tools}'`), command);
  assert.ok(command.includes(`PI_VERIFIER_SCOPE_AUTH='${auth.auth_id}'`));
  assert.ok(command.includes("--exclude-tools 'mcp__*,"));
  const file = join(base, auth.auth_id, "authorization.json");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), auth);
  assert.equal(statSync(file).mode & 0o777, 0o444);
});
it("a scoped spawning grant is always denied", () => {
  assert.deepEqual([...subagentsTest.resolveDenyTools({ spawning: true }, null, true)], ["subagent", "subagent_interrupt", "subagents_list", "subagent_resume"]);
});
it("malformed, duplicate, unsafe-id and invalid-entry scopes produce restricted empty records", () => {
  for (const task of ["```verifier-scope\n{}\n```\n```verifier-scope\n{}\n```", "```verifier-scope\n{", "```verifier-scope\n{}\n```", `\`\`\`verifier-scope\n${JSON.stringify({ ...authorization(), auth_id: "../escape" })}\n\`\`\``, `\`\`\`verifier-scope\n${JSON.stringify({ ...authorization(), entries: [{ id: "bad" }] })}\n\`\`\``]) {
    const command = launch(task);
    assert.ok(command.includes(`--tools '${tools}'`));
    const id = command.match(/PI_VERIFIER_SCOPE_AUTH='([^']+)'/)![1]; roots.push(join(base, id));
    assert.deepEqual(JSON.parse(readFileSync(join(base, id, "authorization.json"), "utf8")).entries, []);
  }
});
it("never overwrites a conflicting authorization and reports the failure", () => {
  const auth = authorization(); const session = `fixture-${randomUUID()}`;
  assert.equal(bindVerifierScope(`\`\`\`verifier-scope\n${JSON.stringify(auth)}\n\`\`\``, session)?.auth_id, auth.auth_id);
  const changed = { ...auth, candidate: { ...auth.candidate, commit_sha: "b".repeat(40) } };
  const binding = bindVerifierScope(`\`\`\`verifier-scope\n${JSON.stringify(changed)}\n\`\`\``, session)!;
  roots.push(join(base, binding.auth_id));
  assert.match(binding.error!, /already bound/);
  assert.deepEqual(JSON.parse(readFileSync(join(base, auth.auth_id, "authorization.json"), "utf8")), auth);
  assert.deepEqual(JSON.parse(readFileSync(join(base, binding.auth_id, "authorization.json"), "utf8")).entries, []);
});
it("an unavailable empty record never binds malformed scope to another authorization's entries", () => {
  const session = `collision-${randomUUID()}`;
  const id = `invalid-${createHash("sha256").update(session).digest("hex").slice(0, 48)}`;
  roots.push(join(base, id)); mkdirSync(join(base, id), { recursive: true });
  const file = join(base, id, "authorization.json");
  writeFileSync(file, "conflicting record", { mode: 0o444 });
  const binding = bindVerifierScope("```verifier-scope\ninvalid\n```", session)!;
  assert.match(binding.auth_id, /^unavailable!/); assert.match(binding.error!, /empty authorization unavailable/);
  assert.equal(readFileSync(file, "utf8"), "conflicting record");
  assert.deepEqual(resumeVerifierScope({ verifierScope: binding }, session), binding);
});
it("resume keeps the exact recorded authorization even if it is unreadable", () => {
  const auth = authorization();
  const binding = { auth_id: auth.auth_id };
  assert.deepEqual(resumeVerifierScope({ verifierScope: binding, task: "ordinary task" }, "fixture"), binding);
});
it("leaves ordinary unfenced launch command selection unchanged", () => {
  const command = launch("ordinary task");
  assert.ok(command.includes("--tools 'bash,write,edit,codemode,tool_search,subagent,caller_ping,subagent_done'"));
  assert.ok(!command.includes("PI_VERIFIER_SCOPE_AUTH"));
  assert.ok(!command.includes("--exclude-tools"));
});
