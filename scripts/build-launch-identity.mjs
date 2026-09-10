import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const include = process.env.NODE_INCLUDE_DIR ?? resolve(dirname(process.execPath), "../include/node");
if (!existsSync(resolve(include, "node_api.h"))) throw new Error("Set NODE_INCLUDE_DIR to this Node installation's C headers");
const source = resolve(root, "pi-extension/subagents/launch-identity-native.c");
// Build-time staging only: place beside the consumer module in a disposable
// package tree. Runtime resolution remains fixed and ignores environment paths.
if (process.argv.length > 3) throw new Error("usage: node build-launch-identity.mjs [staging-directory]");
const outputDirectory = process.argv[2]
  ? resolve(process.argv[2])
  : resolve(root, "pi-extension/subagents");
mkdirSync(outputDirectory, { recursive: true });
const output = resolve(outputDirectory, "launch-identity-native.node");
const args = ["-Wall", "-Wextra", "-Werror", "-shared", "-fPIC", `-I${include}`, source, "-o", output];
// Also give clangd the actual Node header location; generated, never committed.
writeFileSync(resolve(root, "compile_commands.json"), JSON.stringify([{ directory: root, file: source, arguments: ["cc", ...args] }], null, 2));
const result = spawnSync("cc", args, { timeout: 30000, stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
