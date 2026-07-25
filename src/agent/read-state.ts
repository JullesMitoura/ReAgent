/**
 * Per-process registry of files the agent has read or edited (Claude Code
 * readFileState pattern). Two consumers:
 * - compactSession re-injects the most recently read files after a compaction,
 *   so the model does not lose the code it was just working with;
 * - the reminder injector warns the model when a file changed on disk since the
 *   last recorded read/edit (user or linter touched it), so it re-reads instead
 *   of blindly reverting.
 */

import fs from "node:fs";

interface FileRecord {
  /** mtime observed at the last read/edit (0 when the stat failed). */
  mtimeMs: number;
  /** Wall-clock ordering key for recency. */
  at: number;
}

const STATE = new Map<string, FileRecord>();
let clock = 0;

function diskMtime(path: string): number | null {
  try {
    return fs.statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function record(path: string): void {
  STATE.set(path, { mtimeMs: diskMtime(path) ?? 0, at: ++clock });
}

/** Registers a successful read of an absolute path. */
export function recordRead(path: string): void {
  record(path);
}

/** Registers a successful write/edit of an absolute path. */
export function recordEdit(path: string): void {
  record(path);
}

/** The n most recently read/edited paths that still exist on disk, newest first. */
export function recentReads(n: number): string[] {
  return [...STATE.entries()]
    .sort((a, b) => b[1].at - a[1].at)
    .map(([path]) => path)
    .filter((path) => fs.existsSync(path))
    .slice(0, n);
}

/**
 * Paths whose on-disk mtime changed since the last recorded read/edit.
 * Each change is reported once: the stored mtime is refreshed on report, so
 * only a NEW external modification triggers again.
 */
export function checkExternalModifications(): string[] {
  const changed: string[] = [];
  for (const [path, rec] of STATE) {
    const mtime = diskMtime(path);
    if (mtime === null || mtime === rec.mtimeMs) continue;
    changed.push(path);
    rec.mtimeMs = mtime;
  }
  return changed;
}

/** Clears all recorded state (tests). */
export function resetReadState(): void {
  STATE.clear();
  clock = 0;
}
