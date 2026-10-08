// Test-only dependency bootstrap. Host SDKs (@earendil-works/*, @sinclair/typebox)
// are peer/dev dependencies and are deliberately NOT production dependencies.
// Test fixtures that import the extension need them installed under dev rules,
// so this prelude runs `npm run test:prepare` (npm ci --include=dev
// --legacy-peer-deps) when the SDKs are missing or the lockfile digest changed.
// It is invoked from `pretest`, never from postinstall/prepare.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const marker = join(root, "node_modules", ".test-prepare-digest");
const REQUIRED = [
  "node_modules/@earendil-works/pi-coding-agent/package.json",
  "node_modules/@earendil-works/pi-ai/package.json",
  "node_modules/@earendil-works/pi-tui/package.json",
  "node_modules/@sinclair/typebox/package.json",
];
const INSTALL_TIMEOUT_MS = 600_000;

export function lockDigest(cwd = root) {
  return createHash("sha256").update(readFileSync(join(cwd, "package-lock.json"))).digest("hex");
}

export function dependenciesReady(cwd = root, digest = lockDigest(cwd)) {
  if (!REQUIRED.every((rel) => existsSync(join(cwd, rel)))) return false;
  const markerPath = join(cwd, "node_modules", ".test-prepare-digest");
  return existsSync(markerPath) && readFileSync(markerPath, "utf8").trim() === digest;
}

export function ensureTestDependencies({ cwd = root, run = spawnSync } = {}) {
  const digest = lockDigest(cwd);
  if (dependenciesReady(cwd, digest)) return { installed: false };
  const result = run("npm", ["run", "test:prepare"], {
    cwd,
    stdio: "inherit",
    timeout: INSTALL_TIMEOUT_MS,
    env: { ...process.env, SSH_ASKPASS: "/bin/false", SSH_ASKPASS_REQUIRE: "never", DISPLAY: "" },
  });
  if (result.error || result.status !== 0) {
    throw new Error(`test dependency bootstrap failed: ${result.error?.message ?? `exit ${result.status}`}`);
  }
  if (!REQUIRED.every((rel) => existsSync(join(cwd, rel)))) {
    throw new Error("test dependency bootstrap finished but host SDK packages are still missing");
  }
  writeFileSync(join(cwd, "node_modules", ".test-prepare-digest"), `${digest}\n`);
  return { installed: true };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const { installed } = ensureTestDependencies();
    console.log(installed ? "test dependencies installed" : "test dependencies up to date");
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
