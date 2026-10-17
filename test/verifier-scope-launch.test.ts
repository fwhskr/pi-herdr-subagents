import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import subagentsExtension, { __test__ as subagentsTest } from "../pi-extension/subagents/index.ts";
import { __herdrTest__ } from "../pi-extension/subagents/herdr.ts";
import { __engineTest__, bindVerifierScope, realEngineRoles, resumeVerifierScope, VERIFIER_EXCLUSIONS } from "../pi-extension/subagents/verifier-scope.ts";
import { basename, dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
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
// TASK-266.1: launcher-sealed exact rootless-engine entries matching the runtime's tightened contract:
// argv[0] is genuine Podman, engine_pins equal exactly the trusted discovered roles, verifier-real-engine-v1 binding.
// Test-only shared contract oracle: the actual scoped runtime (never a production import).
const ORACLE = process.env.PI_VERIFIER_RUNNER_ORACLE ?? "/home/kris/.pi/agent/extensions/verifier-scoped-runner.ts";
async function runtimeOracle(): Promise<any> {
  const host = resolve(dirname(process.execPath), "../lib/node_modules/@earendil-works/pi-coding-agent");
  const req = createRequire(import.meta.url);
  const { createJiti } = req(req.resolve("jiti", { paths: [host] }));
  const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false, alias: { typebox: req.resolve("typebox", { paths: [host] }) } });
  const runtime: any = await jiti.import(ORACLE);
  assert.ok(runtime.realEngineRoles && runtime.realEngineBinding && runtime.createScopedRunner, `runtime oracle ${ORACLE} lacks the TASK-266 real-engine contract`);
  return runtime;
}
const digest = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const rolePins = () => Object.fromEntries(Object.keys(realEngineRoles()).map(p => [p, digest(p)]));
function engineRequest() {
  const work = mkdtempSync("/home/kris/.pi/agent/var/scope-engine-"); roots.push(work);
  const fsRoot = join(work, "rootfs");
  for (const d of ["bin", "etc", "proc", "sys", "dev", "tmp", "run", "w"]) mkdirSync(join(fsRoot, d), { recursive: true });
  const busybox = join(fsRoot, "bin/busybox"); copyFileSync("/usr/bin/busybox-static", busybox); chmodSync(busybox, 0o755);
  symlinkSync("busybox", join(fsRoot, "bin/sh"));
  for (const f of ["mtab", "hosts", "resolv.conf", "hostname"]) writeFileSync(join(fsRoot, "etc", f), "");
  writeFileSync(join(fsRoot, "etc/passwd"), "root:x:0:0:root:/:/bin/sh\n"); writeFileSync(join(fsRoot, "etc/group"), "root:x:0:\n");
  writeFileSync(join(fsRoot, "run/.containerenv"), "");
  const out = join(work, "out"); mkdirSync(out, { mode: 0o700 });
  const input = join(work, "engine-check.sh"); writeFileSync(input, "printf x >> /w/out/counter\necho ENGINE-OK\n");
  const auth = authorization(); auth.candidate.repo_realpath = work;
  const entry: any = { id: "engine", cwd_realpath: work,
    argv: ["/usr/bin/podman", "run", "--rm", "--pull=never", "--tmpfs", "/sys:ro", "--network=none", "-v", `${work}:/w`, "--rootfs", fsRoot, "/bin/sh", "/w/engine-check.sh"],
    selector: "task-266-real-engine", inputs: [input, busybox], read_roots: [fsRoot], write_roots: [out], env: {}, timeout_s: 30, max_output_bytes: 65536,
    max_attempts: 1, retry_on_failure: false, network: false, real_engine: { engine_pins: rolePins(), input_pins: { [input]: digest(input), [busybox]: digest(busybox) } } };
  auth.entries.push(entry);
  return { auth, entry, input, work, out };
}
const fence = (auth: unknown) => `\`\`\`verifier-scope\n${JSON.stringify(auth)}\n\`\`\``;
it("discovers exactly the runtime's trusted engine roles: genuine Podman, conmon, OCI runtimes and present helpers", async () => {
  const runtime = await runtimeOracle();
  const roles = realEngineRoles();
  assert.deepEqual(roles, runtime.realEngineRoles());
  assert.equal(roles["/usr/bin/podman"], "engine");
  for (const role of ["engine", "conmon", "oci-runtime"]) assert.ok(Object.values(roles).includes(role), role);
  for (const p of Object.keys(roles)) { assert.equal(realpathSync(p), p); assert.equal(statSync(p).uid, 0, p); }
});
it("discovery refuses an untrusted user-owned role executable and an incomplete role set", () => {
  const dir = mkdtempSync("/home/kris/.pi/agent/var/scope-engine-roles-"); roots.push(dir);
  copyFileSync("/usr/bin/podman", join(dir, "podman")); chmodSync(join(dir, "podman"), 0o755);
  assert.throws(() => __engineTest__.discoverEngineRoles([dir]), /not a trusted system executable/);
  assert.throws(() => __engineTest__.discoverEngineRoles(["/usr/libexec/podman"]), /role unavailable on this host: engine/);
});
it("seals a genuine Podman entry the real runtime accepts, runs once confined and refuses to repeat", { timeout: 60000 }, async () => {
  const runtime = await runtimeOracle();
  const { auth, entry, out } = engineRequest(); const session = `engine-${randomUUID()}`;
  const binding = bindVerifierScope(fence(auth), session)!;
  assert.equal(binding.error, undefined); assert.equal(binding.auth_id, auth.auth_id);
  const file = join(base, auth.auth_id, "authorization.json");
  const published = JSON.parse(readFileSync(file, "utf8"));
  const e = published.entries[0];
  assert.equal(e.real_engine.storage_root, join(base, auth.auth_id, "engine-stores", "engine"));
  assert.deepEqual(e.real_engine.engine_pins, entry.real_engine.engine_pins); assert.deepEqual(e.real_engine.input_pins, entry.real_engine.input_pins);
  assert.equal(e.real_engine.binding, runtime.realEngineBinding(published, e));
  const { real_engine: _sealed, ...rest } = e; const { real_engine: _requested, ...requested } = entry;
  assert.deepEqual(rest, requested);
  const stat = statSync(file); assert.equal(stat.mode & 0o777, 0o444); assert.equal(stat.nlink, 1);
  assert.deepEqual(bindVerifierScope(fence(auth), session), binding);
  const runner = runtime.createScopedRunner(auth.auth_id);
  assert.deepEqual(runner.ids, ["engine"]);
  const result = await runner.run({ entry_id: "engine" });
  assert.equal(result.ok, true, JSON.stringify(result)); assert.match(result.stdout, /ENGINE-OK/);
  assert.equal(readFileSync(join(out, "counter"), "utf8"), "x");
  assert.equal(readdirSync(e.real_engine.storage_root).length, 1);
  const repeat = await runtime.createScopedRunner(auth.auth_id).run({ entry_id: "engine" });
  assert.equal(repeat.ok, false); assert.match(repeat.reason, /prior attempt/); assert.equal(readFileSync(join(out, "counter"), "utf8"), "x");
});
it("refuses wrappers, interpreters, user binaries, missing or extra roles and bad pins before publication", () => {
  const roles = realEngineRoles();
  const userBinary = (x: ReturnType<typeof engineRequest>, link = false) => {
    const dir = join(x.work, link ? "link" : "bin"); mkdirSync(dir, { recursive: true }); const p = join(dir, "podman");
    if (link) symlinkSync("/usr/bin/podman", p); else { copyFileSync("/usr/bin/podman", p); chmodSync(p, 0o755); }
    return p;
  };
  const pinned = (x: ReturnType<typeof engineRequest>, p: string) => { x.entry.real_engine.engine_pins[p] = digest(p); };
  type Case = [string, (x: ReturnType<typeof engineRequest>) => void, RegExp];
  const cases: Case[] = [
    ["caller binding", x => { x.entry.real_engine.binding = "a".repeat(64); }, /launcher-authored/],
    ["caller storage", x => { x.entry.real_engine.storage_root = join(base, x.auth.auth_id, "engine-stores", "engine"); }, /launcher-authored/],
    ["dummy engine field", x => { x.entry.real_engine = { nested_userns: true }; }, /Unknown authorization field/],
    ["empty engine request", x => { x.entry.real_engine = {}; }, /Invalid real-engine pins/],
    ...Object.keys(roles).map((p): Case => [`missing ${roles[p]} ${p}`, x => { delete x.entry.real_engine.engine_pins[p]; }, new RegExp(`missing: [^;]*${p.replace(/[.]/g, "\\.")}`)]),
    ["Podman only", x => { x.entry.real_engine.engine_pins = { "/usr/bin/podman": digest("/usr/bin/podman") }; }, /missing: /],
    ["Node argv[0] only Node pinned", x => { x.entry.argv = [process.execPath, x.input]; x.entry.runtime_roots = [process.execPath]; x.entry.real_engine.engine_pins = { [process.execPath]: digest(process.execPath) }; }, /argv\[0\]/],
    ["Node argv[0] with all roles", x => { x.entry.argv = [process.execPath, x.input]; x.entry.runtime_roots = [process.execPath]; pinned(x, process.execPath); }, /argv\[0\]/],
    ["Node argv[0] exact roles", x => { x.entry.argv = [process.execPath, x.input]; }, /argv\[0\]/],
    ["shell wrapper", x => { x.entry.argv = ["/usr/bin/sh", "-c", "exec /usr/bin/podman info"]; pinned(x, "/usr/bin/sh"); }, /argv\[0\]/],
    ["unshare wrapper", x => { x.entry.argv = ["/usr/bin/unshare", "--user", "--map-root-user", "/usr/bin/podman", "info"]; pinned(x, "/usr/bin/unshare"); }, /argv\[0\]/],
    ["renamed user binary", x => { const p = userBinary(x); x.entry.argv = [p, "info"]; x.entry.runtime_roots = [p]; pinned(x, p); }, /argv\[0\]/],
    ["user symlink to engine", x => { x.entry.argv = [userBinary(x, true), "info"]; }, /argv\[0\]/],
    ["extra non-role pin", x => pinned(x, process.execPath), /unexpected: [^;]*node/],
    ["extra user podman in runtime root", x => { const p = userBinary(x); x.entry.runtime_roots = [dirname(p)]; pinned(x, p); }, /unexpected: [^;]*\/bin\/podman/],
    ["runtime root hosting every role", x => { x.entry.runtime_roots = ["/usr"]; }, /Runtime root \/usr may not host an engine role/],
    ["runtime root is a role", x => { x.entry.runtime_roots = ["/usr/bin/podman"]; }, /may not host an engine role/],
    ["wrong podman digest", x => { x.entry.real_engine.engine_pins["/usr/bin/podman"] = "0".repeat(64); }, /executable pin mismatch for \/usr\/bin\/podman/],
    ["wrong helper digest", x => { const p = Object.keys(roles).find(k => roles[k] === "helper") ?? "/usr/bin/conmon"; x.entry.real_engine.engine_pins[p] = "0".repeat(64); }, /executable pin mismatch/],
    ["malformed digest", x => { x.entry.real_engine.engine_pins["/usr/bin/podman"] = "zz"; }, /Invalid real-engine pins/],
    ["input pins incomplete", x => { x.entry.real_engine.input_pins = { [join(x.work, "other")]: "a".repeat(64) }; }, /cover exactly/],
    ["engine config env", x => { x.entry.env.CONTAINERS_CONF = "/usr/share/containers/containers.conf"; }, /Engine configuration environment/],
    ["storage env", x => { x.entry.env.CONTAINERS_STORAGE_CONF = "/usr/share/containers/storage.conf"; }, /Engine configuration environment/],
    ["socket env", x => { x.entry.env.CONTAINER_HOST = "unix:///run/user/1000/podman/podman.sock"; }, /Engine configuration environment/],
    ["with runner self-test", x => { x.entry.runner_self_test = {}; }, /Invalid real-engine request/],
    ["retry", x => { x.entry.retry_on_failure = true; }, /no-retry/],
  ];
  assert.ok(cases.length >= 20);
  for (const [name, mutate, reason] of cases) {
    const x = engineRequest(); mutate(x);
    const binding = bindVerifierScope(fence(x.auth), `refuse-${randomUUID()}`)!; roots.push(join(base, binding.auth_id));
    assert.notEqual(binding.auth_id, x.auth.auth_id, name); assert.match(binding.error ?? "", reason, `${name}: ${binding.error}`);
    assert.deepEqual(JSON.parse(readFileSync(join(base, binding.auth_id, "authorization.json"), "utf8")).entries, [], name);
    assert.equal(existsSync(join(base, x.auth.auth_id)), false, name);
  }
});
it("leaves ordinary unfenced launch command selection unchanged", () => {
  const command = launch("ordinary task");
  assert.ok(command.includes("--tools 'bash,write,edit,codemode,tool_search,subagent,caller_ping,subagent_done'"));
  assert.ok(!command.includes("PI_VERIFIER_SCOPE_AUTH"));
  assert.ok(!command.includes("--exclude-tools"));
});
