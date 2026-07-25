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
import { ToolError } from "../src/tools/errors.js";
import {
  _diagnostics,
  _testHooks,
  editFile,
  listDir,
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
