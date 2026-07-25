/**
 * Tests for the edit_file replacement cascade (findReplacement), 1:1 mirror of
 * the 16 pure tests from tests/test_edit_cascade.py. The end-to-end cases from
 * the Python file (CRLF and /undo) belong to the files.ts phase.
 */

import { describe, expect, it } from "vitest";
import { findReplacement } from "../src/tools/edit-cascade.js";
import { ToolError } from "../src/tools/errors.js";

describe("edit-cascade", () => {
  // --- Strategy 1: exact match (historical behavior preserved) --------------

  it("test_exact_match_single", () => {
    const [newText, replaced] = findReplacement("a = 1\nb = 2\n", "b = 2", "b = 20");
    expect(newText).toBe("a = 1\nb = 20\n");
    expect(replaced).toBe(1);
  });

  it("test_exact_replace_all", () => {
    const [newText, replaced] = findReplacement("aa aa aa", "aa", "b", true);
    expect(newText).toBe("b b b");
    expect(replaced).toBe(3);
  });

  // --- Strategy 2: whitespace-only drift at end of line ----------------------

  it("test_trailing_whitespace_drift_matched_by_strategy2", () => {
    const text = "line one  \nline two\nkeep\n"; // extra spaces after "line one"
    const [newText, replaced] = findReplacement(text, "line one\nline two", "replaced");
    expect(newText).toBe("replaced\nkeep\n");
    expect(replaced).toBe(1);
  });

  it("test_strategy2_replace_all_across_blocks", () => {
    const text = "a \nb \n---\na \nb \n"; // two blocks with trailing whitespace
    const [newText, replaced] = findReplacement(text, "a\nb", "X", true);
    expect(newText).toBe("X\n---\nX\n");
    expect(replaced).toBe(2);
  });

  // --- Strategy 3: different indentation, file indentation preserved ---------

  it("test_indentation_flexible_matched_by_strategy3_preserves_indent", () => {
    const text = "class A:\n    def m(self):\n        return 1\n";
    // old/new come without the file's real indentation (base 0)
    const [newText, replaced] = findReplacement(
      text,
      "def m(self):\n    return 1",
      "def m(self):\n    return 2",
    );
    expect(newText).toBe("class A:\n    def m(self):\n        return 2\n");
    // the file's indentation (4 and 8 spaces) is kept in the result
    expect(newText).toContain("    def m(self):");
    expect(newText).toContain("        return 2");
    expect(replaced).toBe(1);
  });

  it("test_strategy3_preserves_relative_depth", () => {
    const text = "if cond:\n        first()\n        second()\n"; // block indented by 8
    const [newText, replaced] = findReplacement(
      text,
      "first()\nsecond()",
      "first()\nthird()\nsecond()",
    );
    expect(newText).toBe("if cond:\n        first()\n        third()\n        second()\n");
    expect(replaced).toBe(1);
  });

  // --- Strategy 4: literal escapes (\n, \t) emitted by the model -------------

  it("test_escape_normalized_literal_newline_matches_real_block", () => {
    const text = "alpha\nbeta\ngamma\n";
    // old_string arrives with the literal backslash ("alpha\" + "nbeta"), not a real newline
    const [newText, replaced] = findReplacement(text, "alpha\\nbeta", "ALPHA\nBETA");
    expect(newText).toBe("ALPHA\nBETA\ngamma\n");
    expect(replaced).toBe(1);
  });

  it("test_escape_normalized_ambiguous_raises", () => {
    const text = "a\nb\n---\na\nb\n";
    const run = () => findReplacement(text, "a\\nb", "X");
    expect(run).toThrowError(ToolError);
    expect(run).toThrowError(/appears 2 times/);
  });

  it("test_escape_normalized_not_triggered_without_escapes", () => {
    // The file contains the literal backslash; old_string (without escapes)
    // cannot match via unescape, so the cascade ends in "not found".
    const text = "x\\ny\n";
    const run = () => findReplacement(text, "x\ny", "z");
    expect(run).toThrowError(ToolError);
    expect(run).toThrowError(/not found/);
  });

  // --- Strategy 5: block anchor (first/last line, middle with drift) ---------

  it("test_block_anchor_matches_drifted_middle_and_reindents", () => {
    const text =
      "class A:\n" +
      "    def m(self):\n" +
      "        total = compute(items)\n" +
      "        log(total)\n" +
      "        return total\n";
    // middle line with drift: the model recalled "result" instead of "total"
    const old = "def m(self):\n    result = compute(items)\n    log(result)\n    return total";
    const neu = "def m(self):\n    return compute(items)";
    const [newText, replaced] = findReplacement(text, old, neu);
    expect(newText).toBe("class A:\n    def m(self):\n        return compute(items)\n");
    expect(replaced).toBe(1);
  });

  it("test_block_anchor_ambiguous_raises", () => {
    const block = "def go():\n    a = 1\n    return a\n";
    const text = block + "# sep\n" + block;
    // middle with drift ("b" instead of "a") matches both blocks by similarity
    const run = () => findReplacement(text, "def go():\n    b = 1\n    return a", "X");
    expect(run).toThrowError(ToolError);
    expect(run).toThrowError(/block anchor matches 2 locations/);
  });

  it("test_block_anchor_below_threshold_falls_through", () => {
    const text = "start\nmiddle line here\nend\n";
    const run = () => findReplacement(text, "start\ncompletely different content\nend", "X");
    expect(run).toThrowError(ToolError);
    expect(run).toThrowError(/not found/);
  });

  it("test_exact_match_wins_over_block_anchor", () => {
    // An exact match and a copy with drift: the exact one (strategy 1) resolves
    // on its own, without the block anchor turning the copy into ambiguity.
    const text =
      "def f():\n    x = 1\n    return x\n" +
      "# copia com drift\n" +
      "def f():\n    y = 1\n    return x\n";
    const [newText, replaced] = findReplacement(
      text,
      "def f():\n    x = 1\n    return x",
      "def f():\n    return 1",
    );
    expect(replaced).toBe(1);
    expect(newText.startsWith("def f():\n    return 1\n# copia com drift\n")).toBe(true);
    expect(newText).toContain("y = 1"); // the drifted copy stayed intact
  });

  // --- Ambiguity and absence of match ----------------------------------------

  it("test_ambiguous_exact_match_raises", () => {
    const run = () => findReplacement("x = 1\nx = 1\n", "x = 1", "y");
    expect(run).toThrowError(ToolError);
    expect(run).toThrowError(/appears 2 times/);
  });

  it("test_ambiguous_line_strategy_match_raises", () => {
    // Exact fails (every block has trailing whitespace), but strategy 2 finds 2.
    const text = "a \nb \n---\na \nb \n";
    const run = () => findReplacement(text, "a\nb", "X");
    expect(run).toThrowError(ToolError);
    expect(run).toThrowError(/appears 2 times/);
  });

  it("test_no_match_raises", () => {
    const run = () => findReplacement("hello world\n", "not here", "q");
    expect(run).toThrowError(ToolError);
    expect(run).toThrowError(/not found/);
  });
});
