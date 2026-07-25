// Read-state registry: files the agent read/edited, recency for post-compact
// re-injection, and detection of external (user/linter) modifications.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  checkExternalModifications,
  recentReads,
  recordEdit,
  recordRead,
  resetReadState,
} from "../src/agent/read-state.js";
import { config } from "../src/config.js";
import { editFile, readFile, writeFile } from "../src/tools/files.js";

const originalRoot = config.root;
let project: string;

beforeEach(() => {
  resetReadState();
  project = config.setRoot(fs.mkdtempSync(path.join(os.tmpdir(), "reagent-rstate-")));
  config.autoApprove = true;
  config.contextFile = false;
});

afterEach(() => {
  resetReadState();
  config.setRoot(originalRoot);
  fs.rmSync(project, { recursive: true, force: true });
});

function touch(name: string, content = "data\n"): string {
  const p = path.join(project, name);
  fs.writeFileSync(p, content);
  return p;
}

/** Bumps the on-disk mtime deterministically (no sleeping). */
function bumpMtime(p: string): void {
  const future = new Date(Date.now() + 5_000);
  fs.utimesSync(p, future, future);
}

describe("read-state", () => {
  it("recentReads returns newest first and skips deleted files", () => {
    const a = touch("a.txt");
    const b = touch("b.txt");
    const c = touch("c.txt");
    recordRead(a);
    recordRead(b);
    recordRead(c);
    fs.rmSync(b);
    expect(recentReads(5)).toEqual([c, a]);
    expect(recentReads(1)).toEqual([c]);
  });

  it("re-reading a file moves it to the front", () => {
    const a = touch("a.txt");
    const b = touch("b.txt");
    recordRead(a);
    recordRead(b);
    recordRead(a);
    expect(recentReads(5)).toEqual([a, b]);
  });

  it("checkExternalModifications flags a changed file once per change", () => {
    const a = touch("a.txt");
    recordRead(a);
    expect(checkExternalModifications()).toEqual([]);

    bumpMtime(a);
    expect(checkExternalModifications()).toEqual([a]);
    expect(checkExternalModifications()).toEqual([]); // already notified

    fs.utimesSync(a, new Date(Date.now() + 10_000), new Date(Date.now() + 10_000));
    expect(checkExternalModifications()).toEqual([a]); // a NEW change notifies again
  });

  it("a recordRead/recordEdit clears the pending modification", () => {
    const a = touch("a.txt");
    recordRead(a);
    bumpMtime(a);
    recordRead(a); // agent re-read the file: state is fresh again
    expect(checkExternalModifications()).toEqual([]);
  });

  it("deleted files are not reported", () => {
    const a = touch("a.txt");
    recordRead(a);
    fs.rmSync(a);
    expect(checkExternalModifications()).toEqual([]);
  });

  // --- files.ts hooks ---------------------------------------------------------

  it("readFile records the read", () => {
    const a = touch("a.txt", "hello\n");
    readFile("a.txt");
    expect(recentReads(5)).toEqual([a]);
  });

  it("writeFile and editFile record the edit with a fresh mtime", async () => {
    await writeFile("w.txt", "one\ntwo\n");
    const p = path.join(project, "w.txt");
    expect(recentReads(5)).toEqual([p]);
    expect(checkExternalModifications()).toEqual([]); // own write is not "external"

    await editFile("w.txt", "two", "TWO");
    expect(checkExternalModifications()).toEqual([]);

    bumpMtime(p);
    expect(checkExternalModifications()).toEqual([p]);
  });
});
