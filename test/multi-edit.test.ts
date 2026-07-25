// 1:1 mirror of tests/test_multi_edit.py: sequential application, atomicity
// (all-or-nothing), replace_all per edit, single permission prompt, input
// validation and /undo. Fixture equivalent to the conftest `project`, with
// automatic approval.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ChangeTracker } from "../src/changes.js";
import { config } from "../src/config.js";
import { newTurnContext, runWithTurn } from "../src/turn-context.js";
import { ToolError } from "../src/tools/errors.js";
import { multiEdit } from "../src/tools/files.js";

type Edits = Parameters<typeof multiEdit>[1];

const originalRoot = config.root;
let project: string;

beforeEach(() => {
  project = config.setRoot(fs.mkdtempSync(path.join(os.tmpdir(), "reagent-medit-")));
  config.autoApprove = true;
  config.contextFile = false;
});

afterEach(() => {
  config.setRoot(originalRoot);
  fs.rmSync(project, { recursive: true, force: true });
});

/** Same dispatch mapping for controlled errors: "Error: {msg}". */
async function likeDispatch(fn: () => Promise<string>): Promise<string> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ToolError) return `Error: ${err.message}`;
    throw err;
  }
}

async function toolError(fn: () => Promise<string>): Promise<ToolError> {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ToolError);
    return err as ToolError;
  }
  throw new Error("expected ToolError, none was thrown");
}

describe("multi_edit", () => {
  it("test_multi_edit_applies_edits_in_order", async () => {
    fs.writeFileSync(path.join(project, "m.py"), "a = 1\nb = 2\n");
    const result = await multiEdit("m.py", [
      { old_string: "a = 1", new_string: "a = 10" },
      { old_string: "a = 10", new_string: "a = 100" }, // operates on the previous result
      { old_string: "b = 2", new_string: "b = 20" },
    ]);
    expect(fs.readFileSync(path.join(project, "m.py"), "utf8")).toBe("a = 100\nb = 20\n");
    expect(result).toContain("3 edits");
  });

  it("test_multi_edit_atomic_when_an_edit_fails", async () => {
    const p = path.join(project, "m.txt");
    fs.writeFileSync(p, "one\ntwo\n");
    const before = fs.readFileSync(p);
    const err = await toolError(() =>
      multiEdit("m.txt", [
        { old_string: "one", new_string: "ONE" },
        { old_string: "missing", new_string: "x" },
      ]),
    );
    expect(err.message).toContain("edit 2");
    expect(fs.readFileSync(p).equals(before)).toBe(true); // byte-identical: nothing was written
  });

  it("test_multi_edit_replace_all_per_edit", async () => {
    fs.writeFileSync(path.join(project, "r.txt"), "aa aa\nbb\n");
    await multiEdit("r.txt", [
      { old_string: "aa", new_string: "c", replace_all: true },
      { old_string: "bb", new_string: "d" },
    ]);
    expect(fs.readFileSync(path.join(project, "r.txt"), "utf8")).toBe("c c\nd\n");
  });

  it("test_multi_edit_asks_permission_once", async () => {
    // confirm_file monkeypatch becomes a count in the turn's permissionHandler
    const calls: [string, string][] = [];
    config.autoApprove = false;
    const ctx = newTurnContext({
      permissionHandler: async (kind, action) => {
        calls.push([kind, action]);
        return "once";
      },
    });
    fs.writeFileSync(path.join(project, "p.txt"), "x\ny\n");
    await runWithTurn(ctx, () =>
      multiEdit("p.txt", [
        { old_string: "x", new_string: "X" },
        { old_string: "y", new_string: "Y" },
      ]),
    );
    expect(calls.length).toBe(1);
    expect(calls[0]![0]).toBe("edit");
    expect(calls[0]![1]).toContain("(2 edits)");
  });

  it("test_multi_edit_denied_leaves_file_untouched", async () => {
    config.autoApprove = false; // non-tty: denies
    const p = path.join(project, "d.txt");
    fs.writeFileSync(p, "keep\n");
    const result = await multiEdit("d.txt", [{ old_string: "keep", new_string: "gone" }]);
    expect(result).toBe("User denied edit permission.");
    expect(fs.readFileSync(p, "utf8")).toBe("keep\n");
  });

  it("test_multi_edit_rejects_empty_edits", async () => {
    fs.writeFileSync(path.join(project, "e.txt"), "x");
    await toolError(() => multiEdit("e.txt", []));
  });

  it("test_multi_edit_rejects_malformed_edits", async () => {
    fs.writeFileSync(path.join(project, "e.txt"), "x");
    const missing = await toolError(() =>
      multiEdit("e.txt", [{ old_string: "x" }] as unknown as Edits),
    );
    expect(missing.message).toContain("edit 1");
    await toolError(() => multiEdit("e.txt", ["not an object"] as unknown as Edits));
    const badFlag = await toolError(() =>
      multiEdit("e.txt", [
        { old_string: "x", new_string: "y", replace_all: "yes" },
      ] as unknown as Edits),
    );
    expect(badFlag.message).toContain("replace_all");
  });

  it("test_multi_edit_via_dispatch_reports_failing_index", async () => {
    fs.writeFileSync(path.join(project, "d.py"), "a = 1\n");
    const out = await likeDispatch(() =>
      multiEdit("d.py", [{ old_string: "nope", new_string: "x" }]),
    );
    expect(out.startsWith("Error:")).toBe(true);
    expect(out).toContain("edit 1");
  });

  it("test_multi_edit_preserves_crlf", async () => {
    const p = path.join(project, "crlf.txt");
    fs.writeFileSync(p, Buffer.from("one\r\ntwo\r\n", "latin1"));
    await multiEdit("crlf.txt", [
      { old_string: "one", new_string: "ONE" },
      { old_string: "two", new_string: "TWO" },
    ]);
    expect(fs.readFileSync(p).equals(Buffer.from("ONE\r\nTWO\r\n", "latin1"))).toBe(true);
  });

  it("test_undo_restores_pre_batch_content", async () => {
    const p = path.join(project, "u.txt");
    fs.writeFileSync(p, "alpha\nbeta\n");
    const tracker = new ChangeTracker();
    tracker.startTurn();
    await runWithTurn(newTurnContext({ changes: tracker }), () =>
      multiEdit("u.txt", [
        { old_string: "alpha", new_string: "A" },
        { old_string: "beta", new_string: "B" },
      ]),
    );
    expect(fs.readFileSync(p, "utf8")).toBe("A\nB\n");
    tracker.undo();
    expect(fs.readFileSync(p, "utf8")).toBe("alpha\nbeta\n");
  });
});
