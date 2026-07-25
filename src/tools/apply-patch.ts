/**
 * Port of src/tools/apply_patch.py: the apply_patch tool (Codex CLI format).
 *
 * A single call applies a multi-file, multi-hunk patch anchored on CONTEXT (no
 * line numbers). Application is atomic: the whole patch is parsed and the new
 * contents are computed in memory BEFORE any write; if a hunk fails to match or
 * the user denies a file, nothing is applied. Permission is asked once PER FILE
 * (write/edit/delete) with a short diff preview, and each write goes through
 * changes.record (via TurnContext) so /undo works as it does in write_file.
 */

import fs from "node:fs";
import path from "node:path";

import { config } from "../config.js";
import { diffPreview as sharedDiffPreview } from "../lib/text-diff.js";
import { confirmFile, denialMessage } from "../permissions.js";
import { currentTurn } from "../turn-context.js";
import { ToolError } from "./errors.js";
import { _diagnostics, assertUnchangedOnDisk, assertWritable, resolvePath } from "./files.js";

const _BEGIN = "*** Begin Patch";
const _END = "*** End Patch";
const _ADD = "*** Add File: ";
const _DELETE = "*** Delete File: ";
const _UPDATE = "*** Update File: ";
const _MOVE = "*** Move to: ";
const _EOF = "*** End of File";

// cap on the diff preview shown in the confirmation
const _PREVIEW_LINES = 40;

// Appended to unexpected-line errors: teaches the valid syntax to the model.
const _SYNTAX_HELP =
  "valid directives: '*** Begin Patch', '*** End Patch', '*** Add File: ', " +
  "'*** Update File: ', '*** Delete File: ', '*** Move to: ', '*** End of File'; " +
  "hunk lines must start with ' ' (context), '-' (removal), '+' (addition) or '@@' (anchor)";

/** A change block from an Update File. */
interface Hunk {
  header: string | null; // text after @@ (optional anchor, e.g. "def f():")
  lines: [string, string][]; // (op, text), op in ' ', '-', '+'
  eof: boolean; // must match at the END of the file (*** End of File)
}

interface FileOp {
  kind: "add" | "delete" | "update";
  path: string;
  moveTo: string | null;
  addLines: string[];
  hunks: Hunk[];
}

/** An already-validated operation, with the final content computed in memory. */
interface Planned {
  op: FileOp;
  src: string;
  dest: string | null; // move destination (null when no rename)
  before: Buffer | null; // snapshot for changes.record (null if it did not exist)
  after: string | null; // final content in '\n' space (null for delete)
  newline: string; // dominant newline of the original, re-emitted on write
}

// --- helpers ------------------------------------------------------------------

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Python's repr() for strings (error messages identical to the original). */
function pyRepr(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of s) {
    if (ch === "\\") out += "\\\\";
    else if (ch === quote) out += "\\" + quote;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else {
      const code = ch.codePointAt(0)!;
      if (code < 0x20 || code === 0x7f) out += "\\x" + code.toString(16).padStart(2, "0");
      else out += ch;
    }
  }
  return out + quote;
}

// --- parser -------------------------------------------------------------------

/** Consumes the hunks of an Update File from body[i]; returns [hunks, next i]. */
function parseHunks(body: string[], i: number, filePath: string): [Hunk[], number] {
  const hunks: Hunk[] = [];
  let cur: Hunk | null = null;

  const close = (): void => {
    if (cur === null) return;
    if (cur.lines.length === 0) {
      throw new ToolError(`invalid patch: empty hunk in Update File '${filePath}'`);
    }
    // hunk with only blank context (empty line lost between sections): discard
    if (cur.lines.some(([op, text]) => op !== " " || text.trim())) hunks.push(cur);
    cur = null;
  };

  while (i < body.length) {
    const line = body[i]!;
    if (line.trimEnd() === _EOF) {
      if (cur === null || cur.lines.length === 0) {
        throw new ToolError(`invalid patch: '${_EOF}' without a hunk in '${filePath}'`);
      }
      cur.eof = true;
      close();
      i += 1;
    } else if (line.startsWith("*** ")) {
      break; // next file section; the caller validates the directive
    } else if (line.startsWith("@@")) {
      close();
      cur = { header: line.slice(2).trim() || null, lines: [], eof: false };
      i += 1;
    } else if (line === "" || " -+".includes(line[0]!)) {
      if (cur === null) cur = { header: null, lines: [], eof: false }; // implicit hunk
      cur.lines.push(line ? [line[0]!, line.slice(1)] : [" ", ""]);
      i += 1;
    } else {
      throw new ToolError(
        `invalid patch: unexpected line in Update File '${filePath}': ${pyRepr(line)} ` +
          `(${_SYNTAX_HELP})`,
      );
    }
  }
  close();
  return [hunks, i];
}

/** Validates the whole syntax and returns the operations; does not touch the filesystem. */
function parsePatch(patch: string): FileOp[] {
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  while (lines.length && !lines[0]!.trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
  if (!lines.length || lines[0]!.trim() !== _BEGIN) {
    throw new ToolError(`invalid patch: must start with '${_BEGIN}'`);
  }
  if (lines.length < 2 || lines[lines.length - 1]!.trim() !== _END) {
    throw new ToolError(`invalid patch: must end with '${_END}'`);
  }
  const body = lines.slice(1, -1);
  const ops: FileOp[] = [];
  const seen = new Set<string>();

  const claim = (raw: string, directive: string): string => {
    const p = raw.trim();
    if (!p) throw new ToolError(`invalid patch: '${directive.trim()}' without a path`);
    if (seen.has(p)) throw new ToolError(`invalid patch: path '${p}' appears more than once`);
    seen.add(p);
    return p;
  };

  let i = 0;
  while (i < body.length) {
    const line = body[i]!;
    if (line.startsWith(_ADD)) {
      const p = claim(line.slice(_ADD.length), _ADD);
      i += 1;
      const content: string[] = [];
      while (i < body.length && !body[i]!.startsWith("*** ")) {
        if (!body[i]!.startsWith("+")) {
          throw new ToolError(
            `invalid patch: every line of Add File '${p}' must start with '+'`,
          );
        }
        content.push(body[i]!.slice(1));
        i += 1;
      }
      ops.push({ kind: "add", path: p, moveTo: null, addLines: content, hunks: [] });
    } else if (line.startsWith(_DELETE)) {
      ops.push({
        kind: "delete",
        path: claim(line.slice(_DELETE.length), _DELETE),
        moveTo: null,
        addLines: [],
        hunks: [],
      });
      i += 1;
    } else if (line.startsWith(_UPDATE)) {
      const p = claim(line.slice(_UPDATE.length), _UPDATE);
      i += 1;
      let moveTo: string | null = null;
      if (i < body.length && body[i]!.startsWith(_MOVE)) {
        moveTo = claim(body[i]!.slice(_MOVE.length), _MOVE);
        i += 1;
      }
      const [hunks, next] = parseHunks(body, i, p);
      i = next;
      if (!hunks.length && moveTo === null) {
        throw new ToolError(`invalid patch: Update File '${p}' has no hunks`);
      }
      ops.push({ kind: "update", path: p, moveTo, addLines: [], hunks });
    } else if (line.startsWith(_MOVE)) {
      throw new ToolError(
        "invalid patch: '*** Move to:' must come right after '*** Update File:'",
      );
    } else if (!line.trim()) {
      i += 1; // blank line between sections: tolerated
    } else {
      throw new ToolError(`invalid patch: unexpected line: ${pyRepr(line)} (${_SYNTAX_HELP})`);
    }
  }
  if (!ops.length) throw new ToolError("invalid patch: no file operations between the markers");
  return ops;
}

// --- locating and applying hunks ----------------------------------------------

// Unicode normalization (same code points as Codex's seek_sequence.rs): exotic
// dashes, quotes and spaces become ASCII on the last pass of the ladder.
const _CANON = new Map<number, string>();
// hyphens and typographic dashes (U+2010..U+2015) and the minus sign U+2212
for (let c = 0x2010; c < 0x2016; c++) _CANON.set(c, "-");
_CANON.set(0x2212, "-");
// curly single quotes, acute accent and backtick
for (const c of [0x2018, 0x2019, 0x201b, 0x00b4, 0x0060]) _CANON.set(c, "'");
// curly and angular double quotes
for (const c of [0x201c, 0x201d, 0x201f, 0x00ab, 0x00bb]) _CANON.set(c, '"');
// nbsp, typographic spaces (U+2000..U+200A), narrow nbsp, math space, ideographic
_CANON.set(0x00a0, " ");
for (let c = 0x2000; c < 0x200b; c++) _CANON.set(c, " ");
for (const c of [0x202f, 0x205f, 0x3000]) _CANON.set(c, " ");

function _canon(s: string): string {
  let out = "";
  for (const ch of s) out += _CANON.get(ch.codePointAt(0)!) ?? ch;
  return out;
}

// Tolerance ladder: exact, trailing ws, edge ws, Unicode + edges. Each pass
// scans ALL positions before falling to the next: an exact match further ahead
// beats an approximate match behind.
const _PASSES: ((s: string) => string)[] = [
  (s) => s,
  (s) => s.trimEnd(),
  (s) => s.trim(),
  (s) => _canon(s).trim(),
];

/** First position >= start where old matches; with eof, only the end of the file. */
function findSequence(
  lines: string[],
  old: string[],
  start: number,
  eof = false,
): number | null {
  for (const key of _PASSES) {
    const want = old.map(key);
    if (eof) {
      const pos = lines.length - old.length;
      if (
        pos >= Math.max(start, 0) &&
        want.every((w, k) => key(lines[pos + k]!) === w)
      ) {
        return pos;
      }
      continue;
    }
    for (let pos = start; pos <= lines.length - old.length; pos++) {
      let ok = true;
      for (let k = 0; k < old.length; k++) {
        if (key(lines[pos + k]!) !== want[k]) {
          ok = false;
          break;
        }
      }
      if (ok) return pos;
    }
  }
  return null;
}

/** True if the pattern ends in discardable blank context (retry without it). */
function dropLastBlank(hunkLines: [string, string][], old: string[]): boolean {
  const last = hunkLines[hunkLines.length - 1];
  return old.length > 1 && last !== undefined && last[0] === " " && !last[1].trim();
}

/** Diagnostic error: where the search started (1-based) and the expected block. */
function noMatchError(
  n: number,
  rel: string,
  old: string[],
  searchFrom: number,
  eof: boolean,
): ToolError {
  const where = eof ? "at the end of the file " : "";
  const block = old.map((line) => `    ${line}`).join("\n");
  return new ToolError(
    `hunk ${n} in ${rel} does not match the file content ${where}` +
      `(searched from line ${searchFrom + 1}); expected context:\n${block}\n` +
      "no changes applied",
  );
}

/** Applies the hunks in order over the lines; errors if any fails to match. */
function applyHunks(lines: string[], hunks: Hunk[], rel: string): string[] {
  const out = [...lines];
  let pos = 0; // each hunk's search starts after the end of the previous hunk
  for (let n = 1; n <= hunks.length; n++) {
    const hunk = hunks[n - 1]!;
    let headerAt: number | null = null;
    if (hunk.header !== null) {
      // @@ anchor: finds the header line and searches for the context after it
      const want = _canon(hunk.header).trim();
      for (let idx = pos; idx < out.length; idx++) {
        if (_canon(out[idx]!).trim() === want) {
          headerAt = idx;
          break;
        }
      }
    }
    const searchFrom = headerAt !== null ? headerAt + 1 : pos;
    let old = hunk.lines.filter(([op]) => op !== "+").map(([, text]) => text);
    let hunkLines = hunk.lines;
    let start: number;
    let end: number;
    if (!old.length) {
      // additions-only hunk: a declared but missing anchor is an error
      // (silently inserting at EOF would put the code in the wrong place);
      // without an anchor, or with *** End of File, the target is the file end.
      if (hunk.header !== null && headerAt === null && !hunk.eof) {
        throw new ToolError(
          `hunk ${n} in ${rel}: anchor '@@ ${hunk.header}' not found; ` + "no changes applied",
        );
      }
      start = hunk.eof || headerAt === null ? out.length : headerAt + 1;
      end = start;
    } else if (hunk.eof) {
      let found = findSequence(out, old, pos, true);
      if (found === null && dropLastBlank(hunkLines, old)) {
        // retry without the final blank context line (common when the model
        // copies an extra \n at the end of the pattern)
        found = findSequence(out, old.slice(0, -1), pos, true);
        if (found !== null) {
          old = old.slice(0, -1);
          hunkLines = hunkLines.slice(0, -1);
        }
      }
      if (found === null) {
        throw noMatchError(n, rel, old, Math.max(out.length - old.length, 0), true);
      }
      start = found;
      end = found + old.length;
    } else {
      let found = findSequence(out, old, searchFrom);
      if (found === null && searchFrom !== pos) {
        found = findSequence(out, old, pos); // tolerance: the @@ anchor did not help
      }
      if (found === null && dropLastBlank(hunkLines, old)) {
        const trimmed = old.slice(0, -1);
        found = findSequence(out, trimmed, searchFrom);
        if (found === null && searchFrom !== pos) {
          found = findSequence(out, trimmed, pos);
        }
        if (found !== null) {
          old = trimmed;
          hunkLines = hunkLines.slice(0, -1);
        }
      }
      if (found === null) throw noMatchError(n, rel, old, searchFrom, false);
      start = found;
      end = found + old.length;
    }
    const repl: string[] = [];
    let cursor = start;
    for (const [op, text] of hunkLines) {
      if (op === "+") {
        repl.push(text);
      } else {
        if (op === " ") repl.push(out[cursor]!); // keeps the file's version
        cursor += 1;
      }
    }
    out.splice(start, end - start, ...repl);
    pos = start + repl.length;
  }
  return out;
}

// --- application -----------------------------------------------------------------

function _rel(p: string): string {
  return path.relative(config.root, p);
}

/** Short unified diff for the confirmation (limited to _PREVIEW_LINES); see lib/text-diff.ts. */
function diffPreview(before: string, after: string, relFrom: string, relTo: string): string {
  return sharedDiffPreview(before, after, relFrom, relTo, _PREVIEW_LINES);
}

/** Applies a patch in Codex format (see APPLY_PATCH_SCHEMA). */
export async function applyPatch(patch: string): Promise<string> {
  if (typeof patch !== "string") {
    throw new ToolError("invalid patch: patch must be a string");
  }
  const ops = parsePatch(patch);

  // 1) Compute everything in memory: any error here leaves the project intact.
  const planned: Planned[] = [];
  for (const op of ops) {
    const src = resolvePath(op.path);
    const rel = _rel(src);
    if (op.kind === "add") {
      assertWritable(src);
      if (fs.existsSync(src)) {
        throw new ToolError(`cannot add ${rel}: file already exists (use '*** Update File:')`);
      }
      const after = op.addLines.join("\n") + (op.addLines.length ? "\n" : "");
      planned.push({ op, src, dest: null, before: null, after, newline: "\n" });
    } else if (op.kind === "delete") {
      assertWritable(src);
      if (!isFile(src)) throw new ToolError(`cannot delete ${rel}: file not found`);
      planned.push({ op, src, dest: null, before: fs.readFileSync(src), after: null, newline: "\n" });
    } else {
      // update
      assertWritable(src);
      if (!isFile(src)) throw new ToolError(`cannot update ${rel}: file not found`);
      let dest: string | null = null;
      if (op.moveTo) {
        dest = resolvePath(op.moveTo);
        assertWritable(dest);
        if (fs.existsSync(dest)) {
          throw new ToolError(`cannot move ${rel} to ${_rel(dest)}: destination already exists`);
        }
      }
      const before = fs.readFileSync(src);
      const raw = before.toString("utf8");
      const newline = raw.includes("\r\n") ? "\r\n" : "\n";
      // work in '\n' space and re-emit the dominant newline on write
      const text = raw.replace(/\r\n/g, "\n");
      const hadNl = text.endsWith("\n");
      const lines = hadNl ? text.slice(0, -1).split("\n") : text ? text.split("\n") : [];
      const newLines = applyHunks(lines, op.hunks, rel);
      const after = newLines.length ? newLines.join("\n") + (hadNl ? "\n" : "") : "";
      planned.push({ op, src, dest, before, after, newline });
    }
  }

  // 2) Permission per file, BEFORE any write: denying one aborts everything.
  for (const plan of planned) {
    const rel = _rel(plan.src);
    let kind: "write" | "edit" | "delete";
    let action: string;
    let preview: string;
    if (plan.op.kind === "add") {
      kind = "write";
      action = `apply patch: create file ${rel}`;
      preview = diffPreview("", plan.after ?? "", "/dev/null", rel);
    } else if (plan.op.kind === "delete") {
      kind = "delete";
      action = `apply patch: delete file ${rel}`;
      const beforeText = (plan.before ?? Buffer.alloc(0)).toString("utf8");
      preview = diffPreview(beforeText, "", rel, "/dev/null");
    } else {
      kind = "edit";
      action = `apply patch: edit file ${rel}`;
      let relTo = rel;
      if (plan.dest !== null) {
        relTo = _rel(plan.dest);
        action = `apply patch: edit and rename ${rel} -> ${relTo}`;
      }
      const beforeText = (plan.before ?? Buffer.alloc(0)).toString("utf8");
      preview = diffPreview(beforeText.replace(/\r\n/g, "\n"), plan.after ?? "", rel, relTo);
    }
    if (!(await confirmFile(kind, action, rel, preview))) {
      // cancel/timeout swap the "User denied" for a neutral message
      return denialMessage(
        `User denied ${kind} permission for ${rel}; patch aborted, no files changed.`,
      );
    }
  }

  // 3) Write: each file goes through changes.record first, for /undo.
  // Permission (step 2) can await user input for a long time; re-check right
  // before each mutation that the file was not touched by another writer
  // between the read in step 1 and now (same guard as write_file/edit_file).
  const changes = currentTurn()?.changes ?? null;
  const written: string[] = [];
  for (const plan of planned) {
    if (plan.op.kind === "delete") {
      assertUnchangedOnDisk(plan.src, plan.before);
      changes?.record(plan.src, plan.before);
      fs.unlinkSync(plan.src);
      continue;
    }
    let after = plan.after ?? "";
    if (plan.newline !== "\n") after = after.split("\n").join(plan.newline);
    if (plan.dest !== null) {
      // move: writes the destination and removes the source (/undo reverts both)
      assertUnchangedOnDisk(plan.src, plan.before);
      assertUnchangedOnDisk(plan.dest, null);
      changes?.record(plan.src, plan.before);
      changes?.record(plan.dest, null);
      fs.mkdirSync(path.dirname(plan.dest), { recursive: true });
      fs.writeFileSync(plan.dest, after);
      fs.unlinkSync(plan.src);
      written.push(plan.dest);
    } else {
      assertUnchangedOnDisk(plan.src, plan.before);
      changes?.record(plan.src, plan.before);
      fs.mkdirSync(path.dirname(plan.src), { recursive: true });
      fs.writeFileSync(plan.src, after);
      written.push(plan.src);
    }
  }

  // 4) Summary + diagnostics of the written files (.py/.js).
  const counts: Record<"add" | "update" | "delete", number> = { add: 0, update: 0, delete: 0 };
  const detail: string[] = [];
  for (const plan of planned) {
    counts[plan.op.kind] += 1;
    const rel = _rel(plan.src);
    if (plan.op.kind === "add") detail.push(`A ${rel}`);
    else if (plan.op.kind === "delete") detail.push(`D ${rel}`);
    else if (plan.dest !== null) detail.push(`U ${rel} (renamed to ${_rel(plan.dest)})`);
    else detail.push(`U ${rel}`);
  }
  const notes = written.map((p) => _diagnostics(p)).join("");
  const summary =
    `applied patch: ${counts.add} added, ${counts.update} updated, ` +
    `${counts.delete} deleted`;
  return [summary, ...detail].join("\n") + notes;
}

export const APPLY_PATCH_SCHEMA = {
  type: "function",
  function: {
    name: "apply_patch",
    description:
      "Applies a single context-anchored patch that can add, update, delete and rename " +
      "several files in ONE call (no line numbers; each hunk is located by its context " +
      "lines). Prefer this over several edit_file calls whenever a change spans multiple " +
      "files or multiple hunks. The patch is atomic: if any hunk fails to match or any " +
      "file is denied, nothing is applied. Format:\n" +
      "*** Begin Patch\n" +
      "*** Update File: src/app.py\n" +
      "@@ def main():\n" +
      "     total = 0\n" +
      "-    return total\n" +
      "+    return total + 1\n" +
      "*** Add File: docs/note.md\n" +
      "+Hello\n" +
      "*** Delete File: tmp/old.txt\n" +
      "*** End Patch\n" +
      "Context lines start with a space, removals with '-', additions with '+'. Use " +
      "'*** Move to: new/path' right after an Update File line to rename the file, and " +
      "'*** End of File' after a hunk that must anchor at the end of the file. " +
      "Requires user approval.",
    parameters: {
      type: "object",
      properties: {
        patch: {
          type: "string",
          description: "Full patch text, from '*** Begin Patch' to '*** End Patch'",
        },
      },
      required: ["patch"],
    },
  },
};
