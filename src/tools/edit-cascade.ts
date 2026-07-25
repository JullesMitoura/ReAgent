/**
 * edit_file replacement cascade (port of find_replacement and helpers
 * from src/tools/files.py, lines 141-334).
 *
 * PURE function (string to string, no I/O), deterministic. When old is not an
 * exact substring, it falls back progressively to looser per-line strategies,
 * keeping the uniqueness rules of the exact match:
 *
 * 1. exact substring;
 * 2. per-line match ignoring trailing whitespace;
 * 3. per-line match ignoring leading indentation (the file's real indentation
 *    is preserved and new is reindented with relative depth);
 * 4. exact match with literal escapes normalized (\n, \t, quotes);
 * 5. fuzzy block anchor (first/last line anchor, middle >= 0.7 similarity
 *    via difflib's ratio).
 *
 * Uniqueness per strategy: 1 hit uses it; > 1 without replaceAll throws; 0 falls
 * through to the next. Nothing matched: "old_string not found in the file".
 */

import { ToolError } from "./errors.js";
import { ratio } from "../lib/similarity.js";

// non-overlapping count, semantics of Python's str.count
function countOccurrences(text: string, sub: string): number {
  if (sub === "") return Array.from(text).length + 1;
  let count = 0;
  let pos = 0;
  for (;;) {
    const idx = text.indexOf(sub, pos);
    if (idx === -1) break;
    count += 1;
    pos = idx + sub.length;
  }
  return count;
}

// non-overlapping replacement with a cap, semantics of Python's str.replace
function replaceOccurrences(text: string, old: string, neu: string, max: number): string {
  if (old === "") {
    // str.replace with an empty pattern inserts neu between each code point
    const chars = Array.from(text);
    let out = "";
    let done = 0;
    for (let k = 0; k <= chars.length; k++) {
      if (done < max) {
        out += neu;
        done += 1;
      }
      if (k < chars.length) out += chars[k]!;
    }
    return out;
  }
  let out = "";
  let pos = 0;
  let done = 0;
  while (done < max) {
    const idx = text.indexOf(old, pos);
    if (idx === -1) break;
    out += text.slice(pos, idx) + neu;
    pos = idx + old.length;
    done += 1;
  }
  return out + text.slice(pos);
}

// (start, end) in chars of each line of text.split("\n"), end without the newline
function lineSpans(text: string): [number, number][] {
  const spans: [number, number][] = [];
  let pos = 0;
  for (const line of text.split("\n")) {
    spans.push([pos, pos + line.length]);
    pos += line.length + 1; // +1 for the "\n" that split discarded
  }
  return spans;
}

function leadingWs(line: string): string {
  return line.slice(0, line.length - line.trimStart().length);
}

// smallest whitespace prefix among non-empty lines ("" if none)
function minIndent(lines: string[]): string {
  let best: string | null = null;
  for (const line of lines) {
    if (line.trim() !== "") {
      const ws = leadingWs(line);
      if (best === null || ws.length < best.length) best = ws;
    }
  }
  return best ?? "";
}

// rebases neu so the least-indented line lands at targetIndent,
// preserving the relative depth; blank lines stay without indentation
function reindent(neu: string, targetIndent: string): string {
  const lines = neu.split("\n");
  const base = minIndent(lines).length;
  const out: string[] = [];
  for (const line of lines) {
    if (line.trim() !== "") out.push(targetIndent + line.slice(base));
    else out.push("");
  }
  return out.join("\n");
}

function blockMatches(block: string[], oldLines: string[], flexibleIndent: boolean): boolean {
  for (let k = 0; k < oldLines.length; k++) {
    const got = block[k]!;
    const want = oldLines[k]!;
    if (flexibleIndent) {
      if (got.trimStart() !== want.trimStart()) return false;
    } else if (got.trimEnd() !== want.trimEnd()) {
      return false;
    }
  }
  return true;
}

/**
 * Matches contiguous blocks of lines; returns [newText, replaced] or null
 * with 0 matches. flexibleIndent=false ignores only trailing whitespace; true
 * also ignores each line's leading indentation and reindents neu to the file's
 * real indentation. Ambiguity throws the "appears N times" error,
 * exactly like the exact match.
 */
function matchByLines(
  text: string,
  old: string,
  neu: string,
  replaceAll: boolean,
  flexibleIndent: boolean,
): [string, number] | null {
  const textLines = text.split("\n");
  const oldLines = old.split("\n");
  const n = oldLines.length;
  const spans = lineSpans(text);
  const matches: [number, number, string][] = []; // (start, end, replacement)
  let i = 0;
  while (i <= textLines.length - n) {
    const block = textLines.slice(i, i + n);
    if (blockMatches(block, oldLines, flexibleIndent)) {
      const start = spans[i]![0];
      const end = spans[i + n - 1]![1];
      const repl = flexibleIndent ? reindent(neu, minIndent(block)) : neu;
      matches.push([start, end, repl]);
      i += n; // non-overlapping advance, like str.replace/str.count
    } else {
      i += 1;
    }
  }
  if (matches.length === 0) return null;
  if (matches.length > 1 && !replaceAll) {
    throw new ToolError(
      `old_string appears ${matches.length} times; make it unique or use replace_all=true`,
    );
  }
  const use = replaceAll ? matches : matches.slice(0, 1);
  let result = text;
  for (let k = use.length - 1; k >= 0; k--) {
    // back to front keeps the earlier offsets valid
    const [start, end, repl] = use[k]!;
    result = result.slice(0, start) + repl + result.slice(end);
  }
  return [result, use.length];
}

const ESCAPES: Record<string, string> = {
  n: "\n",
  t: "\t",
  "'": "'",
  '"': '"',
  "`": "`",
  "\\": "\\",
};

// converts literal escapes emitted by the model (\n, \t, quotes) into real chars
function unescape(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const next = s[i + 1];
    if (s[i] === "\\" && next !== undefined && ESCAPES[next] !== undefined) {
      out += ESCAPES[next]!;
      i += 2;
    } else {
      out += s[i]!;
      i += 1;
    }
  }
  return out;
}

/**
 * Fuzzy block match anchored on old's first/last non-empty line
 * (compared with trim). Only for old with >= 3 lines. A candidate is a
 * region of the same n lines whose edges match the anchors; the middle is scored
 * with difflib's ratio over the join of the trimmed lines and accepted at >= 0.7.
 * neu is reindented for each matched block. Returns [newText, replaced] or null.
 */
function matchByAnchor(
  text: string,
  old: string,
  neu: string,
  replaceAll: boolean,
): [string, number] | null {
  const oldLines = old.split("\n");
  const n = oldLines.length;
  if (n < 3) return null;
  const anchors = oldLines.map((line) => line.trim()).filter((line) => line !== "");
  if (anchors.length < 2) return null;
  const first = anchors[0]!;
  const last = anchors[anchors.length - 1]!;
  const oldMiddle = oldLines
    .slice(1, -1)
    .map((line) => line.trim())
    .join("\n");
  const textLines = text.split("\n");
  const spans = lineSpans(text);
  const matches: [number, number, string][] = []; // (start, end, replacement)
  let i = 0;
  while (i <= textLines.length - n) {
    const block = textLines.slice(i, i + n);
    if (block[0]!.trim() === first && block[block.length - 1]!.trim() === last) {
      const middle = block
        .slice(1, -1)
        .map((line) => line.trim())
        .join("\n");
      if (ratio(oldMiddle, middle) >= 0.7) {
        const start = spans[i]![0];
        const end = spans[i + n - 1]![1];
        matches.push([start, end, reindent(neu, minIndent(block))]);
        i += n; // non-overlapping advance, like matchByLines
        continue;
      }
    }
    i += 1;
  }
  if (matches.length === 0) return null;
  if (matches.length > 1 && !replaceAll) {
    throw new ToolError(
      `old_string block anchor matches ${matches.length} locations; ` +
        "make it unique or use replace_all=true",
    );
  }
  let result = text;
  for (let k = matches.length - 1; k >= 0; k--) {
    // back to front keeps the earlier offsets valid
    const [start, end, repl] = matches[k]!;
    result = result.slice(0, start) + repl + result.slice(end);
  }
  return [result, matches.length];
}

/**
 * Locates old within text via the ordered cascade and returns
 * [newText, replaced]. Throws ToolError on ambiguity or absence of a match.
 */
export function findReplacement(
  text: string,
  old: string,
  replacement: string,
  replaceAll = false,
): [string, number] {
  const count = countOccurrences(text, old);
  if (count === 1) return [replaceOccurrences(text, old, replacement, 1), 1];
  if (count > 1) {
    if (replaceAll) return [replaceOccurrences(text, old, replacement, Infinity), count];
    throw new ToolError(
      `old_string appears ${count} times; make it unique or use replace_all=true`,
    );
  }
  for (const flexibleIndent of [false, true]) {
    const found = matchByLines(text, old, replacement, replaceAll, flexibleIndent);
    if (found !== null) return found;
  }
  const unescaped = unescape(old);
  if (unescaped !== old) {
    // only when old really carried literal escapes
    const unescapedCount = countOccurrences(text, unescaped);
    if (unescapedCount === 1) {
      return [replaceOccurrences(text, unescaped, replacement, 1), 1];
    }
    if (unescapedCount > 1) {
      if (replaceAll) {
        return [replaceOccurrences(text, unescaped, replacement, Infinity), unescapedCount];
      }
      throw new ToolError(
        `old_string appears ${unescapedCount} times; make it unique or use replace_all=true`,
      );
    }
  }
  const found = matchByAnchor(text, old, replacement, replaceAll);
  if (found !== null) return found;
  throw new ToolError("old_string not found in the file");
}
