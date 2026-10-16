#!/usr/bin/env node
// TASK-261 hermetic launcher verification fixture (test harness only).
//
// Runs the exact launcher-affected test files against a PRIVATE copy of this
// package whose launch-scratch base is relocated under a caller-supplied scratch
// root. The source checkout, its node_modules and the production
// SCRATCH_BASE are never written: the copy holds only pi-extension/, the
// selected tests and package metadata (no .git), node_modules is a symlink to the
// source dependency root, the child's TMPDIR is a private directory beside the
// copy, and everything the fixture created is removed afterwards.
//
// Usage:
//   node test/scoped-launcher-fixture.mjs --scratch <dir inside /home/kris/.pi> [--source <package root>]
// Exit status mirrors the child `node --test`; 124 on the 60 s timeout; 2 on usage errors.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PI_ROOT = "/home/kris/.pi";
const CHILD_TIMEOUT_MS = 60_000;
export const SELECTED_TESTS = Object.freeze([
  "test/task450-resume-tools-allowlist.test.ts",
  "test/task261-stale-widget-ctx.test.ts",
  "test/subagent-done-autoexit.test.ts",
  "test/harness-drivers.test.ts",
]);
const METADATA = ["package.json", "package-lock.json", "config.json.example"];
const SCRATCH_MODULE = "pi-extension/subagents/scratch-lifecycle.ts";
const SCRATCH_LINE = 'export const SCRATCH_BASE = "/home/kris/.pi/agent/var/lane-scratch";';

class UsageError extends Error {}

function parseArgs(argv) {
  const out = { source: resolve(dirname(fileURLToPath(import.meta.url)), ".."), scratch: undefined };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if ((flag === "--source" || flag === "--scratch") && value !== undefined) {
      out[flag.slice(2)] = value;
      i++;
    } else {
      throw new UsageError(`unknown or incomplete argument: ${flag}`);
    }
  }
  if (!out.scratch) throw new UsageError("--scratch <dir inside /home/kris/.pi> is required");
  return out;
}

function insidePi(path) {
  return path.startsWith(`${PI_ROOT}/`);
}

function validate({ source, scratch }) {
  for (const [name, value] of [["source", source], ["scratch", scratch]]) {
    if (!isAbsolute(value)) throw new UsageError(`--${name} must be absolute: ${value}`);
  }
  const src = realpathSync(source);
  if (!existsSync(join(src, SCRATCH_MODULE)) || !existsSync(join(src, "node_modules"))) {
    throw new UsageError(`--source is not a prepared package root: ${src}`);
  }
  for (const test of SELECTED_TESTS) {
    if (!existsSync(join(src, test))) throw new UsageError(`selected test missing in source: ${test}`);
  }
  if (!insidePi(resolve(scratch))) throw new UsageError(`--scratch must stay inside ${PI_ROOT}: ${scratch}`);
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const root = realpathSync(scratch);
  // allocateScratch refuses symlinked bases, so the relocated base must be canonical.
  if (root !== resolve(scratch)) throw new UsageError(`--scratch must not traverse symlinks: ${scratch}`);
  if (!statSync(root).isDirectory()) throw new UsageError(`--scratch is not a directory: ${root}`);
  if (root === src || root.startsWith(`${src}/`)) throw new UsageError("--scratch must be outside the source checkout");
  return { source: src, scratch: root };
}

export function prepareCopy(source, work) {
  const copy = join(work, "package");
  mkdirSync(copy);
  cpSync(join(source, "pi-extension"), join(copy, "pi-extension"), { recursive: true });
  for (const file of METADATA) cpSync(join(source, file), join(copy, file));
  mkdirSync(join(copy, "test"));
  for (const test of SELECTED_TESTS) cpSync(join(source, test), join(copy, test));
  symlinkSync(join(source, "node_modules"), join(copy, "node_modules"), "dir");

  const laneScratch = join(work, "lane-scratch");
  mkdirSync(laneScratch, { mode: 0o700 });
  const module = join(copy, SCRATCH_MODULE);
  const text = readFileSync(module, "utf8");
  const matches = text.split(SCRATCH_LINE).length - 1;
  if (matches !== 1) throw new Error(`expected exactly one SCRATCH_BASE constant in ${SCRATCH_MODULE}, found ${matches}`);
  writeFileSync(module, text.replace(SCRATCH_LINE, `export const SCRATCH_BASE = ${JSON.stringify(laneScratch)};`));
  return { copy, laneScratch };
}

function main() {
  let args;
  try {
    args = validate(parseArgs(process.argv.slice(2)));
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`scoped-launcher-fixture: ${error.message}`);
    return 2;
  }
  const work = mkdtempSync(join(args.scratch, "launcher-fixture-"));
  try {
    const { copy, laneScratch } = prepareCopy(args.source, work);
    // Test temp dirs (os.tmpdir()) also stay inside the owned private copy.
    const tmp = join(work, "tmp");
    mkdirSync(tmp, { mode: 0o700 });
    console.log(`scoped-launcher-fixture: copy ${copy}; lane scratch ${laneScratch}; tmp ${tmp}`);
    const child = spawnSync(process.execPath, ["--test", "--test-reporter=spec", ...SELECTED_TESTS], {
      cwd: copy,
      env: { ...process.env, TMPDIR: tmp },
      stdio: "inherit",
      timeout: CHILD_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    if (child.error?.code === "ETIMEDOUT") {
      console.error(`scoped-launcher-fixture: child node --test exceeded ${CHILD_TIMEOUT_MS} ms`);
      return 124;
    }
    if (child.error) throw child.error;
    return child.status ?? 1;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
