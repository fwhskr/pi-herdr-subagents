import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import done from '../pi-extension/subagents/subagent-done.ts';
import { waitForCompletion } from '../pi-extension/subagents/completion.ts';

const channel = 'pi:held-input-delivery-failed:v1';
const valid = { version: 1, reason: 'held resume lost eligibility', holdId: 'fixture-hold', queuedAt: 1, deadlineAt: 2 };
const root = '/home/kris/.pi/agent/var/task-205-runtime';
const originalEnv = { ...process.env };
const originalArgv = [...process.argv];
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  process.argv.splice(0, process.argv.length, ...originalArgv);
});

function boot(options: { main?: boolean; unrelated?: boolean; autoExit?: string } = {}) {
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'run-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'child.jsonl');
  writeFileSync(file, '');
  process.env.PI_SUBAGENT_AUTO_EXIT = options.autoExit ?? '1';
  process.env.PI_SUBAGENT_ID = 'fixture-run';
  process.env.PI_SUBAGENT_SESSION = file;
  delete process.env.PI_SUBAGENT_ACTIVITY_FILE;
  if (options.main) delete process.env.PI_SUBAGENT_ID;
  process.argv.splice(0, process.argv.length, 'node', 'fixture', '--session', options.unrelated ? 'other.jsonl' : file);
  const lifecycle = new Map<string, Function>();
  const bus = new Map<string, (data: unknown) => void>();
  const warnings: string[] = [];
  let shutdowns = 0;
  const ctx = { cwd: dir, shutdown() { shutdowns++; }, ui: { notify(message: string) { warnings.push(message); }, setWidget() {} }, sessionManager: { getSessionFile: () => file, getEntries: () => [] } };
  done({
    events: { on(name: string, handler: (data: unknown) => void) { bus.set(name, handler); return () => bus.delete(name); } },
    on(name: string, handler: Function) { lifecycle.set(name, handler); },
    registerTool() {}, registerCommand() {}, registerShortcut() {}, getAllTools: () => [],
  } as any, { onReady(hooks) { cleanups.push(hooks.unregisterCrashHooks); } });
  const fire = (name: string, data: unknown = {}) => lifecycle.get(name)?.(data, ctx);
  fire('session_start');
  return { file, warnings, fire, emit: (data: unknown, name = channel) => bus.get(name)?.(data), shutdowns: () => shutdowns };
}

it('held delivery failure reaches the real parent completion consumer without an agent turn, exactly once', async () => {
  const child = boot();
  child.emit(valid);
  assert.equal(child.shutdowns(), 1);
  const durable = `${child.file}.terminal.fixture-run.json`;
  const payload = JSON.parse(readFileSync(`${child.file}.exit`, 'utf8'));
  assert.equal(payload.type, 'error');
  assert.equal(payload.forcedExit, true);
  assert.equal(payload.runId, 'fixture-run');
  assert.equal(payload.workerPid, process.pid);
  assert.ok(Number.isFinite(payload.workerStartTime));
  assert.equal(payload.exitCode, 1);
  assert.equal(payload.errorMessage, valid.reason);
  assert.deepEqual(JSON.parse(readFileSync(durable, 'utf8')), payload);
  const result = await waitForCompletion(AbortSignal.timeout(1000), { sessionFile: child.file, expectedSidecarWriter: { runId: 'fixture-run', workerPid: payload.workerPid, workerStartTime: payload.workerStartTime }, intervalMs: 1, readTerminalTail: async () => '' });
  assert.equal(result.exitCode, 1);
  assert.equal(result.errorMessage, valid.reason);
  child.emit(valid);
  child.emit({ ...valid, holdId: 'second-hold' });
  child.fire('agent_settled');
  assert.equal(child.shutdowns(), 1);
  assert.equal(existsSync(`${child.file}.exit`), false, 'parent consumption is not followed by duplicate publication');
  assert.deepEqual(JSON.parse(readFileSync(durable, 'utf8')), payload);
});

it('malformed failures report a bounded warning without terminal effects', () => {
  const child = boot();
  for (const data of [null, {}, { ...valid, version: 2 }, { ...valid, holdId: '' }, { ...valid, holdId: ' '.repeat(3) }, { ...valid, holdId: 'x'.repeat(129) }, { ...valid, reason: 'x'.repeat(1025) }, { ...valid, reason: 42 }, { ...valid, reason: '' }, { ...valid, reason: '   ' }, { ...valid, queuedAt: NaN }, { ...valid, deadlineAt: Infinity }, { ...valid, queuedAt: '1' }]) {
    child.emit(data);
    assert.equal(child.shutdowns(), 0);
    assert.equal(existsSync(`${child.file}.exit`), false);
  }
  assert.ok(child.warnings.length > 0);
  assert.ok(child.warnings.every(message => message.length <= 1024));
  child.emit(valid);
  assert.equal(child.shutdowns(), 1, 'malformed input does not poison later valid delivery');
});

for (const options of [{ main: true }, { unrelated: true }, { autoExit: '0' }]) {
  it(`nondelegated context ignores valid failures ${JSON.stringify(options)}`, () => {
    const child = boot(options);
    child.emit(valid);
    assert.equal(child.shutdowns(), 0);
    assert.equal(existsSync(`${child.file}.exit`), false);
    assert.equal(existsSync(`${child.file}.terminal.fixture-run.json`), false);
  });
}

it('cancellation and signals after shutdown do not publish failure', () => {
  const child = boot();
  child.emit(valid, 'pi:held-input-cancelled:v1');
  assert.equal(child.shutdowns(), 0);
  child.fire('session_shutdown');
  child.emit(valid);
  assert.equal(child.shutdowns(), 0);
  assert.equal(existsSync(`${child.file}.exit`), false);
});
