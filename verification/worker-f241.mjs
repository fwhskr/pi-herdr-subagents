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
