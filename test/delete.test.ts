// 1:1 mirror of tests/test_delete.py: real deletion (not emptying), byte-for-byte
// undo, path guards and denial without approval.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ChangeTracker } from "../src/changes.js";
import { config } from "../src/config.js";
import { newTurnContext, runWithTurn } from "../src/turn-context.js";
import { ToolError } from "../src/tools/errors.js";
import { deleteFile, writeFile } from "../src/tools/files.js";

const originalRoot = config.root;
let project: string;

beforeEach(() => {
  project = config.setRoot(fs.mkdtempSync(path.join(os.tmpdir(), "reagent-delete-")));
  config.autoApprove = true;
  config.contextFile = false;
});

afterEach(() => {
  config.setRoot(originalRoot);
  fs.rmSync(project, { recursive: true, force: true });
});

describe("delete_file", () => {
  it("test_delete_removes_file_not_empties", async () => {
    await writeFile("gone.txt", "some content\n");
    expect(fs.existsSync(path.join(project, "gone.txt"))).toBe(true);
    const result = await deleteFile("gone.txt");
    expect(result).toBe("Deleted gone.txt");
    // The file ceases to exist (it is not just left empty).
    expect(fs.existsSync(path.join(project, "gone.txt"))).toBe(false);
  });

  it("test_delete_undo_restores_exact_bytes", async () => {
    const original = Buffer.from("linha 1\nlinha 2\n\xff\xfe binario\n", "latin1");
    const p = path.join(project, "data.bin");
    fs.writeFileSync(p, original);
    const tracker = new ChangeTracker();
    tracker.startTurn();
    await runWithTurn(newTurnContext({ changes: tracker }), () => deleteFile("data.bin"));
    expect(fs.existsSync(p)).toBe(false);
    tracker.undo();
    expect(fs.readFileSync(p).equals(original)).toBe(true);
  });

  it("test_delete_on_directory_raises", async () => {
    fs.mkdirSync(path.join(project, "adir"));
    await expect(deleteFile("adir")).rejects.toThrow(ToolError);
    expect(fs.statSync(path.join(project, "adir")).isDirectory()).toBe(true);
  });

  it("test_delete_env_blocked", async () => {
    fs.writeFileSync(path.join(project, ".env"), "SECRET=1");
    await expect(deleteFile(".env")).rejects.toThrow(ToolError);
    expect(fs.existsSync(path.join(project, ".env"))).toBe(true);
  });

  it("test_delete_outside_root_blocked", async () => {
    await expect(deleteFile("../outside.txt")).rejects.toThrow(ToolError);
  });

  it("test_delete_missing_file_raises", async () => {
    await expect(deleteFile("nope.txt")).rejects.toThrow(ToolError);
  });

  it("test_delete_denied_without_approval", async () => {
    fs.writeFileSync(path.join(project, "keep.txt"), "stay");
    config.autoApprove = false; // non-tty: denies
    const result = await deleteFile("keep.txt");
    expect(result).toBe("User denied delete permission.");
    expect(fs.existsSync(path.join(project, "keep.txt"))).toBe(true);
  });
});
