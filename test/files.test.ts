// 1:1 mirror of tests/test_files.py plus the end-to-end encoding tests
// (CRLF/LF) and /undo integrity from tests/test_edit_cascade.py (section 5.2 of
// MIGRATION_SPEC). The dispatch (tools/index.ts) is a future phase: the
// likeDispatch helper reproduces its contract for ToolError ("Error: {msg}").

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ChangeTracker } from "../src/changes.js";
import { config } from "../src/config.js";
import { newTurnContext, runWithTurn } from "../src/turn-context.js";
import type { PermissionHandler } from "../src/turn-context.js";
import { ArgumentError, ToolError } from "../src/tools/errors.js";
import {
  _diagnostics,
  _testHooks,
  deleteFile,
  editFile,
  listDir,
  multiEdit,
  readFile,
  writeFile,
} from "../src/tools/files.js";

const hasPython = (() => {
  try {
    return spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
})();

const originalRoot = config.root;
let project: string;

beforeEach(() => {
  project = config.setRoot(fs.mkdtempSync(path.join(os.tmpdir(), "reagent-files-")));
  config.autoApprove = true;
  config.contextFile = false;
});

afterEach(() => {
  config.setRoot(originalRoot);
  fs.rmSync(project, { recursive: true, force: true });
});

/** Same dispatch mapping for controlled errors: "Error: {msg}". */
async function likeDispatch(fn: () => string | Promise<string>): Promise<string> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ToolError) return `Error: ${err.message}`;
    throw err;
  }
}

/**
 * Runs fn with an injected permissionHandler (autoApprove off), capturing the
 * (kind, action, preview) of every confirmFile call it triggers. Mirrors
 * apply-patch.test.ts's applyWithHandler: the real production path (turn
 * context) rather than monkeypatching confirmFile directly.
 */
async function withCapturedPreview<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; previews: (string | null)[] }> {
  config.autoApprove = false;
  const previews: (string | null)[] = [];
  const handler: PermissionHandler = async (_kind, _action, preview) => {
    previews.push(preview);
    return "once";
  };
  const ctx = newTurnContext({ permissionHandler: handler });
  const result = await runWithTurn(ctx, fn);
  return { result, previews };
}

describe("files", () => {
  it("test_sandbox_blocks_outside_project", async () => {
    expect(await likeDispatch(() => readFile("../outside.txt"))).toContain("access denied");
  });

  it("test_protected_env_blocked", async () => {
    fs.writeFileSync(path.join(project, ".env"), "SECRET=1");
    expect(await likeDispatch(() => readFile(".env"))).toContain("protected file");
  });

  it("test_blocked_directory", async () => {
    const target = path.join(project, ".reagent");
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "x.txt"), "data");
    expect(await likeDispatch(() => readFile(".reagent/x.txt"))).toContain("blocked directory");
  });

  it("test_read_numbering_and_offset", () => {
    fs.writeFileSync(path.join(project, "a.txt"), "one\ntwo\nthree\n");
    const out = readFile("a.txt", 2, 1);
    expect(out).toContain("2\ttwo");
    expect(out).not.toContain("one");
  });

  it("test_read_truncates_very_long_line", () => {
    fs.writeFileSync(path.join(project, "min.js"), "short\n" + "x".repeat(3000) + "\n");
    const out = readFile("min.js");
    expect(out).toContain("... (line truncated)");
    expect(out).not.toContain("x".repeat(3000)); // the huge line was cut at 2000 chars
    expect(out).toContain("short");
  });

  it("test_read_empty_file_returns_reminder", () => {
    fs.writeFileSync(path.join(project, "empty.txt"), "");
    expect(readFile("empty.txt")).toBe(
      "<system-reminder>File exists but is empty.</system-reminder>",
    );
  });

  it("test_read_offset_past_end_warns_with_total_lines", () => {
    fs.writeFileSync(path.join(project, "short.txt"), "one\ntwo\n");
    const out = readFile("short.txt", 50);
    expect(out).toContain("offset 50 is past the end");
    expect(out).toContain("2 lines total");
  });

  it("test_read_rejects_non_numeric_offset", () => {
    fs.writeFileSync(path.join(project, "a.txt"), "one\ntwo\nthree\n");
    // regression: a string offset used to silently degrade (Array.slice(NaN, NaN))
    // to an empty result instead of erroring, so the model would wrongly
    // conclude the file was empty
    expect(() => readFile("a.txt", "abc" as unknown as number)).toThrow(ArgumentError);
  });

  it("test_read_rejects_non_numeric_limit", () => {
    fs.writeFileSync(path.join(project, "a.txt"), "one\ntwo\nthree\n");
    expect(() => readFile("a.txt", 1, "abc" as unknown as number)).toThrow(ArgumentError);
  });

  it("test_read_missing_file_suggests_similar_names", async () => {
    fs.writeFileSync(path.join(project, "config.json"), "{}");
    const out = await likeDispatch(() => readFile("confg.json"));
    expect(out).toContain("file not found");
    expect(out).toContain("Did you mean");
    expect(out).toContain("config.json");
  });

  it("test_read_missing_file_plain_error_without_close_names", async () => {
    const out = await likeDispatch(() => readFile("zzz_qqq.bin"));
    expect(out).toContain("file not found");
    expect(out).not.toContain("Did you mean");
  });

  it("test_write_and_read_roundtrip", async () => {
    const result = await writeFile("novo/dir/file.txt", "hello\nworld");
    expect(result).toContain("created");
    expect(fs.readFileSync(path.join(project, "novo/dir/file.txt"), "utf8")).toBe("hello\nworld");
  });

  it("test_write_denied_without_approval", async () => {
    config.autoApprove = false; // non-tty: deny
    const result = await writeFile("f.txt", "x");
    expect(result).toBe("User denied write permission.");
    expect(fs.existsSync(path.join(project, "f.txt"))).toBe(false);
  });

  it("test_edit_requires_unique_match", async () => {
    fs.writeFileSync(path.join(project, "e.txt"), "aa aa");
    const out = await likeDispatch(() => editFile("e.txt", "aa", "b"));
    expect(out).toContain("appears 2 times");
  });

  it("test_edit_replace_all", async () => {
    fs.writeFileSync(path.join(project, "e.txt"), "aa aa");
    await editFile("e.txt", "aa", "b", true);
    expect(fs.readFileSync(path.join(project, "e.txt"), "utf8")).toBe("b b");
  });

  it("test_list_dir_hides_ignored", () => {
    fs.mkdirSync(path.join(project, ".git"));
    fs.writeFileSync(path.join(project, "visible.txt"), "");
    const out = listDir(".");
    expect(out).toContain("visible.txt");
    expect(out).not.toContain(".git");
  });

  it.skipIf(!hasPython)("test_diagnostics_on_broken_python", async () => {
    const result = await writeFile("bad.py", "def broken(:\n    pass");
    expect(result).toContain("[diagnostics]");
  });

  it.skipIf(!hasPython)("test_diagnostics_silent_on_valid_python", async () => {
    const result = await writeFile("good.py", "x = 1\n");
    expect(result).not.toContain("[diagnostics]");
  });

  it("test_diagnostics_on_broken_js", async () => {
    const result = await writeFile("bad.js", "const x = ;\n");
    expect(result).toContain("[diagnostics]");
  });

  it.skipIf(!hasPython)("test_diagnostics_uses_devnull_stdin", () => {
    const captured: Record<string, unknown> = {};
    const real = _testHooks.spawnSync;
    _testHooks.spawnSync = ((cmd: string, args: string[], opts: Record<string, unknown>) => {
      captured["cmd"] = cmd;
      Object.assign(captured, opts);
      return { status: 0, stdout: "", stderr: "", signal: null, output: [], pid: 0 };
    }) as unknown as typeof _testHooks.spawnSync;
    try {
      fs.writeFileSync(path.join(project, "ok.py"), "x = 1\n");
      _diagnostics(path.join(project, "ok.py"));
    } finally {
      _testHooks.spawnSync = real;
    }
    // stdio[0] "ignore" is the Node equivalent of stdin=subprocess.DEVNULL
    expect((captured["stdio"] as string[])[0]).toBe("ignore");
  });

  it("test_diagnostics_silent_on_valid_js", async () => {
    // with node: passes --check; without node: silent no-op. Never flags.
    const result = await writeFile("good.js", "const x = 1;\n");
    expect(result).not.toContain("[diagnostics]");
  });

  // --- End-to-end: line endings and /undo integrity (test_edit_cascade.py)

  it("test_edit_file_preserves_crlf", async () => {
    const p = path.join(project, "crlf.txt");
    fs.writeFileSync(p, Buffer.from("one\r\ntwo\r\nthree\r\n", "latin1"));
    await editFile("crlf.txt", "two", "TWO");
    expect(fs.readFileSync(p).equals(Buffer.from("one\r\nTWO\r\nthree\r\n", "latin1"))).toBe(true);
  });

  it("test_edit_file_normalizes_new_string_newlines_into_crlf", async () => {
    const p = path.join(project, "crlf.py");
    fs.writeFileSync(p, Buffer.from("a = 1\r\nb = 2\r\n", "latin1"));
    // new_string arrives with '\n'; must not introduce mixed lines in the CRLF file
    await editFile("crlf.py", "b = 2", "b = 2\nc = 3");
    expect(fs.readFileSync(p).equals(Buffer.from("a = 1\r\nb = 2\r\nc = 3\r\n", "latin1"))).toBe(
      true,
    );
  });

  it("test_edit_file_keeps_lf_untouched", async () => {
    const p = path.join(project, "lf.txt");
    fs.writeFileSync(p, Buffer.from("one\ntwo\nthree\n", "latin1"));
    await editFile("lf.txt", "two", "TWO");
    expect(fs.readFileSync(p).equals(Buffer.from("one\nTWO\nthree\n", "latin1"))).toBe(true);
  });

  it("test_undo_restores_non_utf8_bytes_exactly", async () => {
    const p = path.join(project, "bin.dat");
    const original = Buffer.from("\xff\xfe\x00data\r\n", "latin1"); // bytes invalid in UTF-8
    fs.writeFileSync(p, original);
    const tracker = new ChangeTracker();
    tracker.startTurn();
    await runWithTurn(newTurnContext({ changes: tracker }), () =>
      writeFile("bin.dat", "clean text"),
    );
    expect(fs.readFileSync(p).equals(original)).toBe(false);
    tracker.undo();
    expect(fs.readFileSync(p).equals(original)).toBe(true);
  });
});

// --- concurrent-writer guard: write/edit/multi_edit/delete snapshot `before`,
// then AWAIT permission (which can take a long time), then mutate. If another
// writer changes the file on disk in that window, the tool must abort instead
// of silently clobbering it. The permissionHandler itself plays the role of
// "the other writer": it mutates the file synchronously before resolving, the
// same way a concurrent agent's write would land while this call is pending.

describe("concurrent writer guard", () => {
  it("test_write_aborts_when_file_changed_concurrently", async () => {
    const p = path.join(project, "race.txt");
    fs.writeFileSync(p, "original\n");
    const handler: PermissionHandler = async () => {
      fs.writeFileSync(p, "concurrent-writer\n");
      return "once";
    };
    const ctx = newTurnContext({ permissionHandler: handler });
    config.autoApprove = false;
    const out = await runWithTurn(ctx, () => likeDispatch(() => writeFile("race.txt", "mine\n")));
    expect(out).toContain("changed on disk");
    // the concurrent writer's content survived; "mine" never landed
    expect(fs.readFileSync(p, "utf8")).toBe("concurrent-writer\n");
  });

  it("test_edit_aborts_when_file_changed_concurrently", async () => {
    const p = path.join(project, "race-edit.txt");
    fs.writeFileSync(p, "alpha\nbeta\ngamma\n");
    const handler: PermissionHandler = async () => {
      fs.writeFileSync(p, "alpha\nCONCURRENT\ngamma\n");
      return "once";
    };
    const ctx = newTurnContext({ permissionHandler: handler });
    config.autoApprove = false;
    const out = await runWithTurn(ctx, () =>
      likeDispatch(() => editFile("race-edit.txt", "beta", "MINE")),
    );
    expect(out).toContain("changed on disk");
    expect(fs.readFileSync(p, "utf8")).toBe("alpha\nCONCURRENT\ngamma\n");
  });

  it("test_multi_edit_aborts_when_file_changed_concurrently", async () => {
    const p = path.join(project, "race-multi.txt");
    fs.writeFileSync(p, "one\ntwo\nthree\n");
    const handler: PermissionHandler = async () => {
      fs.writeFileSync(p, "one\nCONCURRENT\nthree\n");
      return "once";
    };
    const ctx = newTurnContext({ permissionHandler: handler });
    config.autoApprove = false;
    const out = await runWithTurn(ctx, () =>
      likeDispatch(() => multiEdit("race-multi.txt", [{ old_string: "two", new_string: "MINE" }])),
    );
    expect(out).toContain("changed on disk");
    expect(fs.readFileSync(p, "utf8")).toBe("one\nCONCURRENT\nthree\n");
  });

  it("test_delete_aborts_when_file_changed_concurrently", async () => {
    const p = path.join(project, "race-delete.txt");
    fs.writeFileSync(p, "original\n");
    const handler: PermissionHandler = async () => {
      fs.writeFileSync(p, "concurrent-writer\n");
      return "once";
    };
    const ctx = newTurnContext({ permissionHandler: handler });
    config.autoApprove = false;
    const out = await runWithTurn(ctx, () => likeDispatch(() => deleteFile("race-delete.txt")));
    expect(out).toContain("changed on disk");
    // the concurrently-written file must still be on disk, untouched
    expect(fs.readFileSync(p, "utf8")).toBe("concurrent-writer\n");
  });

  it("test_sequential_edit_within_one_turn_is_unaffected", async () => {
    // the common case (read, then edit once) must NOT be flagged: nothing
    // changes the file between the snapshot and the write in this path
    const p = path.join(project, "sequential.txt");
    fs.writeFileSync(p, "before\n");
    const result = await writeFile("sequential.txt", "after\n");
    expect(result).toContain("overwritten");
    expect(fs.readFileSync(p, "utf8")).toBe("after\n");
  });
});

// --- diff preview shown in the write/edit/multi_edit confirmation ----------

describe("diff preview", () => {
  it("test_edit_preview_marks_single_line_change", async () => {
    fs.writeFileSync(path.join(project, "single.txt"), "alpha\nbeta\ngamma\n");
    const { previews } = await withCapturedPreview(() => editFile("single.txt", "beta", "BETA"));
    expect(previews).toHaveLength(1);
    const lines = previews[0]!.split("\n");
    expect(lines).toContain("-beta");
    expect(lines).toContain("+BETA");
    expect(lines).toContain(" alpha"); // unchanged context, space-prefixed
    expect(lines).toContain(" gamma");
    // the old flat dump is gone
    expect(previews[0]).not.toContain("--- remove ---");
    expect(previews[0]).not.toContain("--- insert ---");
  });

  it("test_edit_preview_marks_multiline_change_with_add_remove_and_context", async () => {
    const content = "line1\nline2\nline3\nline4\nline5\nline6\nline7\n";
    fs.writeFileSync(path.join(project, "multi.txt"), content);
    const { previews } = await withCapturedPreview(() =>
      editFile("multi.txt", "line3\nline4\nline5", "line3\nCHANGED\nline5\nNEWLINE"),
    );
    const lines = previews[0]!.split("\n");
    expect(lines).toContain("-line4"); // removed
    expect(lines).toContain("+CHANGED"); // added in place of line4
    expect(lines).toContain("+NEWLINE"); // added after line5
    expect(lines).toContain(" line3"); // unchanged context before the change
    expect(lines).toContain(" line5"); // unchanged context between the two edits
    expect(lines).toContain(" line6"); // unchanged context after the change
    // line3/line5 must NOT also show up as removed: they are unchanged, not replaced
    expect(lines).not.toContain("-line3");
    expect(lines).not.toContain("-line5");
  });

  it("test_write_preview_diffs_overwrite_against_existing_content", async () => {
    fs.writeFileSync(path.join(project, "over.txt"), "old1\nold2\nold3\n");
    const { previews } = await withCapturedPreview(() =>
      writeFile("over.txt", "old1\nNEW2\nold3\n"),
    );
    const lines = previews[0]!.split("\n");
    expect(lines).toContain("-old2");
    expect(lines).toContain("+NEW2");
    expect(lines).toContain(" old1");
    expect(lines).toContain(" old3");
  });

  it("test_write_preview_for_new_file_marks_all_lines_as_additions", async () => {
    const { previews } = await withCapturedPreview(() => writeFile("brand.txt", "a\nb\n"));
    expect(previews[0]).toContain("--- /dev/null"); // difflib convention for "did not exist"
    const lines = previews[0]!.split("\n");
    expect(lines).toContain("+a");
    expect(lines).toContain("+b");
    // nothing to remove: no removal lines besides the "--- /dev/null" header
    expect(lines.some((l) => l.startsWith("-") && !l.startsWith("---"))).toBe(false);
  });

  it("test_multi_edit_preview_is_one_combined_diff_not_per_edit_blocks", async () => {
    fs.writeFileSync(path.join(project, "m.txt"), "one\ntwo\nthree\nfour\nfive\n");
    const { previews } = await withCapturedPreview(() =>
      multiEdit("m.txt", [
        { old_string: "two", new_string: "TWO" },
        { old_string: "four", new_string: "FOUR" },
      ]),
    );
    expect(previews).toHaveLength(1); // a single confirmation for the whole multi-edit
    const lines = previews[0]!.split("\n");
    expect(lines).toContain("-two");
    expect(lines).toContain("+TWO");
    expect(lines).toContain("-four");
    expect(lines).toContain("+FOUR");
    expect(lines).toContain(" three"); // context between the two edits
    // the old per-edit "[edit N]" markers are gone
    expect(previews[0]).not.toContain("[edit 1]");
    expect(previews[0]).not.toContain("[edit 2]");
  });

  it("test_edit_preview_truncates_very_large_diffs", async () => {
    const before = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n");
    const after = Array.from({ length: 100 }, (_, i) => `CHANGED${i}`).join("\n");
    fs.writeFileSync(path.join(project, "big.txt"), before + "\n");
    const { previews } = await withCapturedPreview(() => editFile("big.txt", before, after));
    expect(previews[0]).toContain("more diff lines");
    // bounded: header + hunk marker + the truncation limit + the marker line itself
    expect(previews[0]!.split("\n").length).toBeLessThan(70);
  });
});
