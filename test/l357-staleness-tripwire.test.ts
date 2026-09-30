import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  assertSpawnCodeFresh,
  __stalenessTest__,
} from "../pi-extension/subagents/staleness-tripwire.ts";
import { runScriptInPane } from "../pi-extension/subagents/terminal.ts";
import { createHerdrSurface } from "../pi-extension/subagents/herdr.ts";
import { __herdrTest__ } from "../pi-extension/subagents/herdr.ts";

const tempRoots = new Set<string>();
const savedPath = process.env.PATH;
const savedHerdrEnv = process.env.HERDR_ENV;

afterEach(() => {
  __stalenessTest__.resetWatchedFiles();
  __herdrTest__.clearCommandAvailability();
  if (savedPath == null) delete process.env.PATH;
  else process.env.PATH = savedPath;
  if (savedHerdrEnv == null) delete process.env.HERDR_ENV;
  else process.env.HERDR_ENV = savedHerdrEnv;
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
  tempRoots.clear();
});

/** Stand-in for one spawn-path source file, snapshotted as the load baseline. */
function watchedStandin(initial = "export const version = 1;\n"): string {
  const root = mkdtempSync(join(tmpdir(), "l357-tripwire-"));
  tempRoots.add(root);
  const file = join(root, "spawn-path.ts");
  writeFileSync(file, initial, "utf8");
  __stalenessTest__.setWatchedFiles([file]);
  return file;
}

/** Minimal fake `herdr` that records argv and exits 0. */
function fakeHerdrBin(root: string): string {
  const bin = join(root, "bin");
  const command = join(bin, "herdr");
  const log = join(root, "herdr.log");
  mkdirSync(bin, { recursive: true });
  writeFileSync(command, "#!/bin/sh\necho \"$@\" >> \"$HERDR_LOG\"\n", "utf8");
  chmodSync(command, 0o755);
  writeFileSync(log, "", "utf8");
  process.env.HERDR_LOG = log;
  process.env.HERDR_ENV = "1";
  process.env.PATH = `${bin}:${savedPath ?? ""}`;
  __herdrTest__.clearCommandAvailability();
  return log;
}

describe("L-357 staleness tripwire", () => {
  it("REFUSES the spawn when on-disk code drifted since load, naming the file", () => {
    const file = watchedStandin();
    writeFileSync(file, "export const version = 2; // patched after spawner started\n", "utf8");
    assert.throws(
      () => assertSpawnCodeFresh("test-spawn"),
      (error: unknown) => {
        const message = String((error as Error)?.message ?? error);
        assert.match(message, /stale spawner/i, "refusal must say the spawner is stale");
        assert.ok(message.includes(file), `refusal must name the file, got: ${message}`);
        assert.match(message, /\/reload/, "refusal must state the required action");
        return true;
      },
    );
  });

  it("does NOT refuse when loaded and on-disk code agree", () => {
    watchedStandin();
    assertSpawnCodeFresh("test-spawn");
  });

  it("runScriptInPane refuses on drift BEFORE writing any launch script", () => {
    const root = mkdtempSync(join(tmpdir(), "l357-scripts-"));
    tempRoots.add(root);
    fakeHerdrBin(root);
    const file = watchedStandin();
    const scriptPath = join(root, "launch.sh");
    writeFileSync(file, "export const version = 2; // patched after spawner started\n", "utf8");
    assert.throws(() => runScriptInPane("pane-x", "echo hi", { scriptPath }), /stale spawner/i);
    assert.equal(existsSync(scriptPath), false, "no launch script may be emitted by a stale spawner");
  });

  it("runScriptInPane still spawns normally when there is no drift", () => {
    const root = mkdtempSync(join(tmpdir(), "l357-scripts-"));
    tempRoots.add(root);
    const log = fakeHerdrBin(root);
    watchedStandin();
    const scriptPath = join(root, "launch.sh");
    const written = runScriptInPane("pane-x", "echo hi", { scriptPath });
    assert.equal(written, scriptPath);
    const head = readFileSync(scriptPath, "utf8").split("\n").slice(0, 3);
    assert.deepEqual(head, [
      "#!/bin/bash",
      "export GIT_SSH_COMMAND='/usr/bin/ssh -o BatchMode=yes -o NumberOfPasswordPrompts=0'",
      "export SSH_ASKPASS=/bin/false SSH_ASKPASS_REQUIRE=never DISPLAY=",
    ]);
    assert.match(readFileSync(log, "utf8"), /pane run/);
  });

  it("createHerdrSurface refuses on drift before touching herdr", () => {
    const file = watchedStandin();
    writeFileSync(file, "export const version = 2; // patched after spawner started\n", "utf8");
    assert.throws(
      () => createHerdrSurface("stale-pane"),
      (error: unknown) => {
        const message = String((error as Error)?.message ?? error);
        assert.ok(message.includes(file), `refusal must name the file, got: ${message}`);
        return true;
      },
    );
  });
});
