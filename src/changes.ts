/**
 * Port of src/changes.py: per-turn file change tracking, enabling /undo without
 * requiring git.
 *
 * write_file/edit_file record each file's snapshot BEFORE the turn's first change;
 * undo() restores in reverse order. Snapshots are raw bytes (Buffer): /undo
 * restores non-UTF-8 files byte for byte. Changes made via bash are NOT tracked.
 *
 * Port adaptation (section 4.1 of MIGRATION_SPEC): Python's module-global state
 * became an instantiable class, scoped per turn via TurnContext.changes;
 * concurrent turns of different sessions do not mix snapshots. The turn owner
 * (REPL, server, exec) creates and injects the instance.
 */

import fs from "node:fs";
import path from "node:path";

import { config } from "./config.js";
import type { ChangeTracker as ChangeTrackerContract } from "./turn-context.js";

/** Path relative to ROOT when contained in it; otherwise the path as given. */
function rel(p: string): string {
  if (!path.isAbsolute(p)) return p;
  const r = path.relative(config.root, p);
  if (!r || r.startsWith("..") || path.isAbsolute(r)) return p;
  return r;
}

export class ChangeTracker implements ChangeTrackerContract {
  // [path, bytes before the turn; null = the file did not exist]
  private changes: [string, Buffer | null][] = [];

  startTurn(): void {
    this.changes.length = 0;
  }

  record(p: string, before: Buffer | null): void {
    // keep only the oldest snapshot per file
    if (!this.changes.some(([existing]) => existing === p)) {
      this.changes.push([p, before]);
    }
  }

  /**
   * Read-only snapshot of what changed this turn, for the terminal's end-of-turn
   * summary. Derived by comparing each recorded snapshot against the file's
   * CURRENT state (a file created then deleted within the same turn nets out
   * to nothing and is omitted). Does not consume the tracker: undo() still
   * works after calling this.
   */
  summary(): { created: string[]; modified: string[]; deleted: string[] } {
    const created: string[] = [];
    const modified: string[] = [];
    const deleted: string[] = [];
    for (const [p, before] of this.changes) {
      const existsNow = fs.existsSync(p);
      if (before === null) {
        if (existsNow) created.push(rel(p));
      } else if (existsNow) {
        modified.push(rel(p));
      } else {
        deleted.push(rel(p));
      }
    }
    return { created, modified, deleted };
  }

  undo(): string {
    if (this.changes.length === 0) {
      return "Nothing to undo (no file changes recorded in the last turn).";
    }
    const lines: string[] = [];
    for (const [p, before] of [...this.changes].reverse()) {
      if (before === null) {
        fs.rmSync(p, { force: true });
        lines.push(`deleted ${rel(p)} (was created this turn)`);
      } else {
        fs.writeFileSync(p, before);
        lines.push(`restored ${rel(p)}`);
      }
    }
    this.changes.length = 0;
    return "Reverted the last turn's file changes:\n" + lines.join("\n");
  }
}
