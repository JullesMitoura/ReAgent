// 1:1 mirror of tests/test_undo.py: per-turn /undo with byte snapshots.
// The file tools (write_file/edit_file) are a future phase; the writeTracked
// helper reproduces their contract with the ChangeTracker: snapshot of the
// bytes BEFORE the turn's first change (null if the file did not exist).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ChangeTracker } from "../src/changes.js";
import { config } from "../src/config.js";

const originalRoot = config.root;
let project: string;
let tracker: ChangeTracker;

beforeEach(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), "reagent-undo-"));
  config.setRoot(project);
  config.autoApprove = true;
  config.contextFile = false;
  tracker = new ChangeTracker();
});

afterEach(() => {
  config.setRoot(originalRoot);
  fs.rmSync(project, { recursive: true, force: true });
});

/** write_file/edit_file equivalent for tracking: snapshot + write. */
function writeTracked(rel: string, content: string): void {
  const p = path.join(project, rel);
  let before: Buffer | null;
  try {
    before = fs.readFileSync(p);
  } catch {
    before = null;
  }
  tracker.record(p, before);
  fs.writeFileSync(p, content);
}

describe("undo", () => {
  it("test_undo_removes_created_file", () => {
    tracker.startTurn();
    writeTracked("created.txt", "new");
    expect(fs.existsSync(path.join(project, "created.txt"))).toBe(true);
    const summary = tracker.undo();
    expect(summary).toContain("deleted");
    expect(fs.existsSync(path.join(project, "created.txt"))).toBe(false);
  });

  it("test_undo_restores_edited_file", () => {
    fs.writeFileSync(path.join(project, "f.txt"), "original");
    tracker.startTurn();
    writeTracked("f.txt", "changed");
    expect(fs.readFileSync(path.join(project, "f.txt"), "utf8")).toBe("changed");
    tracker.undo();
    expect(fs.readFileSync(path.join(project, "f.txt"), "utf8")).toBe("original");
  });

  it("test_undo_keeps_oldest_snapshot_per_file", () => {
    fs.writeFileSync(path.join(project, "f.txt"), "v1");
    tracker.startTurn();
    writeTracked("f.txt", "v2");
    writeTracked("f.txt", "v3");
    tracker.undo();
    expect(fs.readFileSync(path.join(project, "f.txt"), "utf8")).toBe("v1");
  });

  it("test_undo_with_nothing_recorded", () => {
    tracker.startTurn();
    expect(tracker.undo()).toContain("Nothing to undo");
  });
});
