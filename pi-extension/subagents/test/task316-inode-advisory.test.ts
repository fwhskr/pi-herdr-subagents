import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { allocateScratch, cancelUnstartedScratch, capacityWarning, statfsCapacity } from "../scratch-lifecycle.ts";

const fixtures = "/home/kris/.pi/agent/var/task-316-fixtures";

function withScratch(run: (base: string) => void): void {
  mkdirSync(fixtures, { recursive: true });
  const base = mkdtempSync(join(fixtures, "advisory-"));
  try { run(base); } finally { rmSync(base, { recursive: true, force: true }); }
}

test("filesystems without inode accounting report unknown free inodes and stay silent", () => {
  withScratch((base) => {
    // Architect observation: btrfs reports ~597 GB free with f_files = f_ffree = 0 (untracked, not exhausted).
    const observed = statfsCapacity({ files: 0, ffree: 0, bavail: 145901552, bsize: 4096 });
    assert.equal(observed.availableBytes, 145901552 * 4096);
    assert.equal(observed.availableInodes, null);
    assert.equal(capacityWarning(base, () => observed), null);
    const warnings: string[] = [];
    const scratch = allocateScratch(null, { scratchBase: base, capacity: () => observed, warn: (w) => warnings.push(w) });
    assert.deepEqual(warnings, []);
    assert.equal(existsSync(scratch.scratchRoot), true);
    assert.equal(cancelUnstartedScratch(scratch), true);
  });
});

test("measured inode exhaustion still warns accurately and allocation stays advisory", () => {
  withScratch((base) => {
    for (const ffree of [0, 500]) {
      const exhausted = statfsCapacity({ files: 262144, ffree, bavail: 145901552, bsize: 4096 });
      assert.equal(exhausted.availableInodes, ffree);
      const warning = capacityWarning(base, () => exhausted);
      assert.match(warning!, new RegExp(`${ffree} inodes available`));
      const warnings: string[] = [];
      const scratch = allocateScratch(null, { scratchBase: base, capacity: () => exhausted, warn: (w) => warnings.push(w) });
      assert.equal(warnings.length, 1);
      assert.equal(existsSync(scratch.scratchRoot), true);
      assert.equal(cancelUnstartedScratch(scratch), true);
    }
  });
});

test("low bytes warn even when inode usage is unreported, without claiming zero inodes", () => {
  withScratch((base) => {
    const lowBytes = statfsCapacity({ files: 0, ffree: 0, bavail: 1024, bsize: 4096 });
    const warning = capacityWarning(base, () => lowBytes)!;
    assert.match(warning, /low capacity/);
    assert.match(warning, /597627559936|4194304|bytes/);
    assert.doesNotMatch(warning, /0 inodes/);
    assert.match(warning, /unreported/);
    const warnings: string[] = [];
    const scratch = allocateScratch(null, { scratchBase: base, capacity: () => lowBytes, warn: (w) => warnings.push(w) });
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].length <= 240);
    assert.equal(existsSync(scratch.scratchRoot), true);
    assert.equal(cancelUnstartedScratch(scratch), true);
  });
});

test("observation failure stays an advisory and never refuses allocation", () => {
  withScratch((base) => {
    assert.equal(capacityWarning(base, () => { throw new Error("statfs unavailable"); }),
      "[subagent scratch] capacity observation unavailable; launch continues");
    const warnings: string[] = [];
    const scratch = allocateScratch(null, { scratchBase: base, capacity: () => { throw new Error("statfs unavailable"); }, warn: (w) => warnings.push(w) });
    assert.equal(warnings.length, 1);
    assert.equal(existsSync(scratch.scratchRoot), true);
    assert.equal(cancelUnstartedScratch(scratch), true);
  });
});

test("healthy measured and healthy unknown observations produce no warning", () => {
  withScratch((base) => {
    const measured = statfsCapacity({ files: 262144, ffree: 100000, bavail: 145901552, bsize: 4096 });
    assert.equal(capacityWarning(base, () => measured), null);
    assert.equal(capacityWarning(base, () => statfsCapacity({ files: 0, ffree: 0, bavail: 145901552, bsize: 4096 })), null);
  });
});
