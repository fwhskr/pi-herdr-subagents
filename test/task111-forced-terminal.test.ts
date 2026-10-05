import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import done from '../pi-extension/subagents/subagent-done.ts';
import { __test__ as parent } from '../pi-extension/subagents/index.ts';
import { waitForCompletion } from '../pi-extension/subagents/completion.ts';
import { createLifecycle, observeActivity } from '../pi-extension/subagents/lifecycle.ts';
import { readSubagentActivityFile } from '../pi-extension/subagents/activity.ts';

const evidenceRoot = '/home/kris/.pi/agent/var/TASK-111/fixtures';
mkdirSync(evidenceRoot, { recursive: true });
const original = { ...process.env };
const dirs: string[] = [];
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
  Object.assign(process.env, original);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function boot() {
  const dir = mkdtempSync(join(evidenceRoot, 'run-')); dirs.push(dir);
  const file = join(dir, 'child.jsonl'); writeFileSync(file, '');
  process.env.PI_SUBAGENT_AUTO_EXIT = '1';
  process.env.PI_SUBAGENT_ID = 'fixture-run';
  process.env.PI_SUBAGENT_SESSION = file;
  delete process.env.PI_SUBAGENT_ACTIVITY_FILE;
  delete process.env.PI_SUBAGENT_AUTO_EXIT_REARM;
  delete process.env.PI_SUBAGENT_RESUME_INPUT;
  const events = new Map<string, Function>(); const tools = new Map<string, any>();
  const entries: any[] = []; let shutdowns = 0;
  const ctx: any = { cwd: dir, shutdown() { shutdowns++; }, ui: { notify() {}, setWidget() {} }, sessionManager: { getEntries: () => entries } };
  done({ on: (n: string,h: Function) => events.set(n,h), registerTool: (t: any) => tools.set(t.name,t), registerCommand() {}, registerShortcut() {}, getAllTools: () => [], sendUserMessage() {}, appendEntry: (customType: string,data: any) => entries.push({ type: 'custom', customType, data }) } as any);
  const fire = (n: string,e: any = {}) => events.get(n)?.(e,ctx);
  fire('agent_start');
  return { file, ctx, tools, entries, fire, shutdowns: () => shutdowns, settle(messages: any[]) { fire('agent_end', { messages }); fire('agent_settled'); } };
}

for (const stopReason of ['aborted', 'toolUse', undefined]) {
  it(`run-identified autonomous ${String(stopReason)} settle forces truthful terminal delivery and close`, async () => {
    const child = boot();
    child.settle(stopReason ? [{ role: 'assistant', stopReason, errorMessage: 'Operation aborted', content: [] }] : []);
    assert.equal(child.shutdowns(), 1, 'the settled child requests exit, not operator takeover');
    const durable = `${child.file}.terminal.fixture-run.json`;
    assert.ok(existsSync(durable), 'terminal record survives sidecar consumption');
    const payload = JSON.parse(readFileSync(durable, 'utf8'));
    assert.equal(payload.runId, 'fixture-run');
    assert.equal(payload.type, 'error');
    assert.equal(payload.exitCode, stopReason === 'aborted' ? 130 : 1);
    assert.ok(payload.errorMessage, 'failure must name the missing/aborted outcome');
    const result = await waitForCompletion(AbortSignal.timeout(1000), { sessionFile: child.file, expectedSidecarWriter: { runId: 'fixture-run' }, intervalMs: 1, readTerminalTail: async () => '' });
    assert.equal(result.exitCode, payload.exitCode);
    assert.notEqual(result.preservePane, true, 'forced failure must not preserve a quiet pane');
    assert.ok(existsSync(durable));
    child.fire('agent_settled');
    assert.equal(child.shutdowns(), 1, 'repeat settled notification is idempotent');
  });
}

it('normal final report with no close tool is durably delivered and exits', async () => {
  const child = boot();
  child.settle([{ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'verified report' }] }]);
  assert.equal(child.shutdowns(), 1);
  const record = JSON.parse(readFileSync(`${child.file}.terminal.fixture-run.json`, 'utf8'));
  assert.equal(record.exitCode, 0);
  const result = await waitForCompletion(AbortSignal.timeout(1000), { sessionFile: child.file, intervalMs: 1, readTerminalTail: async () => '' });
  assert.equal(result.reason, 'done');
});

it('explicit done and caller ping keep their original result contracts', async () => {
  for (const name of ['subagent_done','caller_ping']) {
    const child = boot();
    await child.tools.get(name).execute('fixture-call', { message: 'need evidence', report: 'finished' }, undefined, undefined, child.ctx);
    const payload = JSON.parse(readFileSync(`${child.file}.exit`, 'utf8'));
    assert.equal(payload.type, name === 'caller_ping' ? 'ping' : 'done');
    assert.equal(payload.exitCode, 0);
    assert.equal(child.shutdowns(), 1);
  }
});

it('legacy/disarmed child is forced by the parent after bounded settled grace, but not before', () => {
  const child = boot();
  writeFileSync(child.file, JSON.stringify({ type: 'message', message: { role: 'assistant', content: [], stopReason: 'aborted', errorMessage: 'Operation aborted' } })+'\n');
  const now = Date.now();
  const activityFile = `${child.file}.activity.json`;
  writeFileSync(activityFile, JSON.stringify({ version:1, runningChildId:'fixture-run', createdAt:now-60000, updatedAt:now-31000, sequence:1, latestEvent:'agent_end', phase:'waiting', agentActive:false, turnActive:false, providerActive:false, toolActive:false, waitingSince:now-31000, settledAt:now-31000 }));
  const read = readSubagentActivityFile(activityFile, 'fixture-run'); assert.ok(read.ok);
  const running: any = { id:'fixture-run', name:'worker', task:'test terminal', sessionFile:child.file, interactive:false, lifecycle:observeActivity(createLifecycle(now-60000),read,now), startTime:now-60000, cli:'pi', surface:'fixture-pane', abortController:new AbortController() };
  assert.equal(parent.settledForcedExitCompletion(running, now-2000), null);
  const result = parent.settledForcedExitCompletion(running, now);
  assert.equal(result.exitCode, 130);
  assert.equal(result.preservePane, undefined);
  assert.ok(result.errorMessage);
  assert.equal(parent.settledForcedExitCompletion({ ...running, interactive:true }, now), null);
  assert.equal(parent.settledForcedExitCompletion({ ...running, lifecycle:createLifecycle(now) }, now), null, 'agent_end alone cannot terminate a continuing turn');
});

for (const [stopReason, parentInterrupted, exitCode, failureKind] of [
  ['aborted', false, 130, 'interrupted'],
  ['aborted', true, 130, 'interrupted'],
  ['toolUse', false, 1, 'no-result'],
  [undefined, false, 1, 'no-result'],
  ['error', false, 1, 'provider'],
] as const) {
  it(`watcher delivers ${failureKind} and closes ${parentInterrupted ? 'parent-interrupted' : String(stopReason)} quiet pane`, async () => {
    const child = boot();
    writeFileSync(child.file, stopReason ? JSON.stringify({ type:'message', message:{ role:'assistant', content:[], stopReason, errorMessage:'Observed provider or abort failure' } })+'\n' : '');
    const dir = join(child.ctx.cwd, 'bin'); mkdirSync(dir);
    const closeLog = join(dir, 'closed'); process.env.TASK111_CLOSE_LOG = closeLog;
    const fake = join(dir, 'herdr');
    writeFileSync(fake, '#!/usr/bin/env node\nconst fs=require("node:fs"); if(process.argv[2]==="pane" && process.argv[3]==="close") fs.appendFileSync(process.env.TASK111_CLOSE_LOG,process.argv[4]+"\\n"); else console.log("{}");\n'); chmodSync(fake,0o755);
    process.env.PATH = dir+':'+original.PATH;
    const now = Date.now();
    const lifecycle = { ...createLifecycle(now-60000), settledAt:now-31000, turn:{ kind:'waiting', startedAt:now-31000 } };
    const running: any = { id:'fixture-run', name:'worker', task:'test terminal', sessionFile:child.file, interactive:false, lifecycle, startTime:now-60000, cli:'pi', surface:'fixture-pane', abortController:new AbortController(), ...(parentInterrupted ? { interruptNudgedAt:now-32000 } : {}) };
    const deadline = setTimeout(() => running.abortController.abort(),2000);
    let result;
    try { result = await parent.watchSubagent(running,running.abortController.signal); }
    finally { clearTimeout(deadline); }
    assert.equal(result.exitCode,exitCode);
    assert.equal(result.failureKind,failureKind);
    assert.equal(readFileSync(closeLog,'utf8'),'fixture-pane\n', 'the production watcher closes exactly once before delivering');
    assert.equal(running.lifecycle.process.kind,'failed', 'no running registry row survives delivery');
    const record = JSON.parse(readFileSync(`${child.file}.terminal.fixture-run.json`,'utf8'));
    assert.equal(record.runId,'fixture-run');
    assert.equal(record.exitCode,exitCode);
  });
}

