import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// L-357 staleness tripwire: the delegated-launch transport neutraliser (L-334
// script preamble in terminal.ts, L-339 pane-wide --env in herdr.ts) is
// emitted by the *spawning* pi process's in-memory copy of this extension, and
// pi does not hot-reload extensions. A pane started before a fix therefore
// keeps spawning with pre-fix code forever, silently. This module records the
// spawn-path files' content hash at load and re-reads them at spawn time; on
// drift the spawn is REFUSED loudly instead of emitting an un-neutralised pane.
//
// Explicit non-goal: a pane that loaded BEFORE this tripwire existed has no
// tripwire in memory, so nothing compares anything for it. An old pane whose
// on-disk bytes are unchanged since it loaded also passes: only byte drift
// trips the check. The tripwire protects the NEXT launch, it complements the
// L-356 pane roll rather than replacing it.

interface WatchedFile {
  path: string;
  loadedHash: string;
}

function sha256Hex(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Absolute paths of the spawn-path sources, resolved from this module's own directory. */
function defaultWatchedPaths(): string[] {
  const dir = dirname(fileURLToPath(import.meta.url));
  return ["terminal.ts", "herdr.ts", "index.ts", "staleness-tripwire.ts"].map((name) =>
    join(dir, name),
  );
}

/**
 * Snapshot current on-disk bytes as the load baseline. Unreadable files are
 * skipped (fail open): the tripwire must never brick spawning for fresh panes.
 */
function snapshot(paths: string[]): WatchedFile[] {
  const out: WatchedFile[] = [];
  for (const path of paths) {
    try {
      out.push({ path, loadedHash: sha256Hex(readFileSync(path)) });
    } catch {
      // Fail open — an unreadable file is not drift.
    }
  }
  return out;
}

const loadedFiles: WatchedFile[] = snapshot(defaultWatchedPaths());

let watchedFiles: WatchedFile[] = loadedFiles;

/**
 * Re-read the watched files and throw if any differ from the load baseline.
 * Unreadable files are skipped (fail open). Pure content comparison: mtime
 * touches, pane age, worker start time and environment never trip it.
 */
export function assertSpawnCodeFresh(context: string): void {
  const drifted: Array<{ path: string; loaded: string; onDisk: string }> = [];
  for (const { path, loadedHash } of watchedFiles) {
    let onDisk: string;
    try {
      onDisk = sha256Hex(readFileSync(path));
    } catch {
      continue;
    }
    if (onDisk !== loadedHash) drifted.push({ path, loaded: loadedHash, onDisk });
  }
  if (drifted.length === 0) return;
  const files = drifted
    .map(({ path, loaded, onDisk }) => `  ${path} (loaded ${loaded.slice(0, 12)}, on-disk ${onDisk.slice(0, 12)})`)
    .join("\n");
  throw new Error(
    `Stale spawner: extension code changed on disk since this pi process loaded it — ` +
      `spawning now would silently use pre-fix code without the transport neutraliser.\n${files}\n` +
      `Run /reload (or restart this pane), then retry the spawn. Context: ${context}`,
  );
}

/** Test seam: point the tripwire at stand-in files without touching the live install. */
export const __stalenessTest__ = {
  /** Snapshot the given files' current bytes as the load baseline (mirrors load semantics). */
  setWatchedFiles: (paths: string[]): void => {
    watchedFiles = snapshot(paths);
  },
  /** Restore the real load baseline. */
  resetWatchedFiles: (): void => {
    watchedFiles = loadedFiles;
  },
};
