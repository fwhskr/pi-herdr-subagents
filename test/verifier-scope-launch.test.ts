import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PiHarnessDriver } from "../pi-extension/subagents/harness/drivers/pi.ts";

const base = "/home/kris/.pi/agent/var/verifier-scope";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const tools = "read,grep,find,ls,verify_run,caller_ping,subagent_done";
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
  return { schema: 1, auth_id, candidate: { repo_realpath: "/home/kris/.pi", commit_sha: "a".repeat(40) }, entries: [] };
}
it("binds a fenced checker to immutable canonical authorization and exact tools despite requested escapes", () => {
  const auth = authorization();
  const command = launch(`Check only this.\n\`\`\`verifier-scope\n${JSON.stringify(auth)}\n\`\`\``);
  assert.ok(command.includes(`--tools '${tools}'`), command);
  assert.ok(command.includes(`PI_VERIFIER_SCOPE_AUTH='${auth.auth_id}'`));
  assert.ok(command.includes("--exclude-tools 'mcp__*,"));
  const file = join(base, auth.auth_id, "authorization.json");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), auth);
  assert.equal(statSync(file).mode & 0o777, 0o444);
});
it("leaves ordinary unfenced launch command selection unchanged", () => {
  const command = launch("ordinary task");
  assert.ok(command.includes("--tools 'bash,write,edit,codemode,tool_search,subagent,caller_ping,subagent_done'"));
  assert.ok(!command.includes("PI_VERIFIER_SCOPE_AUTH"));
  assert.ok(!command.includes("--exclude-tools"));
});
