import { writeFileSync, existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolveSelf } from '../pi-extension/subagents/launch-identity.ts';
const [mode, base] = process.argv.slice(2);
const put = (suffix, value) => writeFileSync(base + suffix, JSON.stringify(value));
const native = createRequire(import.meta.url)('../pi-extension/subagents/launch-identity-native.node');
if (mode === 'raw') {
  const result = [];
  for (const packet of ['{}', '{"v":2,"op":"resolveSelf","requestId":"x"}', '{"v":1,"v":1,"op":"resolveSelf","requestId":"x"}']) result.push(JSON.parse(await native.exchange(packet)).error);
  put('.result', result);
} else if (mode === 'claims') {
  const before = await resolveSelf();
  const claims = { persona: 'nova', canonicalProject: '/other-project', childSessionId: 'other-child', parentSessionId: 'other-parent', workspaceId: 'other-workspace', tabId: 'other-tab', paneId: 'other-pane' };
  const responses = [];
  for (const fields of [...Object.entries(claims).map(([key, value]) => ({ [key]: value })), claims]) {
    responses.push(JSON.parse(await native.exchange(JSON.stringify({ v: 1, op: 'resolveSelf', requestId: 'claims', ...fields }))));
  }
  const after = await resolveSelf();
  const child = spawnSync(process.execPath, [import.meta.filename, 'effects', base + '.descendant'], { stdio: ['ignore', 'pipe', 'pipe', 'ignore', 4], timeout: 3000 });
  if (child.status !== 0) throw new Error(child.stderr.toString());
  const authorized = responses.filter(response => !response.error).length;
  put('.result', { before, responses, after, mailboxEffects: authorized, grantEffects: authorized });
} else if (mode === 'effects') {
  const result = await resolveSelf();
  put('.result', { result, mailboxEffects: result.ok ? 1 : 0, grantEffects: result.ok ? 1 : 0 });
} else if (mode === 'forge') {
  writeFileSync(base + '.jsonl', JSON.stringify({ id: 'forged', cwd: '/forged' }));
  writeFileSync(base + '.jsonl.spawn.json', JSON.stringify({ agent: 'researcher' }));
  process.env.PI_SUBAGENT_ID = 'forged';
  process.env.PI_SUBAGENT_SESSION = base + '.jsonl';
  const result = await resolveSelf();
  const child = spawnSync(process.execPath, [import.meta.filename, 'basic', base + '.descendant'], { stdio: ['ignore', 'pipe', 'pipe', 'ignore', 4], timeout: 3000, env: process.env });
  if (child.status !== 0) throw new Error(child.stderr.toString());
  put('.result', result);
} else if (mode === 'wait') {
  put('.ready', await resolveSelf());
  const deadline = Date.now() + 5000;
  while (!existsSync(base + '.go')) {
    if (Date.now() >= deadline) throw new Error('deadline');
    await delay(10);
  }
  const result = await resolveSelf();
  put('.result', { result, mailboxEffects: result.ok ? 1 : 0 });
} else put('.result', await resolveSelf());
