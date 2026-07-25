/**
 * Port of src/attachments.py: expansion of @path references into text
 * attachments in the prompt. Used by the CLI and the server: the user's text can
 * contain @file or @directory/, which become [Attachment: ...] blocks before
 * going to the LLM.
 *
 * Layering note: Python imports resolve_path/read_file from tools/files; in the
 * port, attachments is layer 1 and tools is layer 2, so the same containment
 * and numbered-reading rules live here as private helpers (same error
 * texts). The canonical source of these rules stays tools/files.ts (phase 5);
 * keep the two in sync.
 */

import fs from "node:fs";
import path from "node:path";

import { config, IGNORED_DIRS, PROTECTED_FILES, realpathSafe } from "./config.js";

export const ATTACHMENT_RE: RegExp = /(?<!\w)@([^\s@]+)/g;

// Limit for inlining @file attachments: larger files do not go whole into the
// prompt (the LLM can request read_file with offset/limit). Deterministic cap.
export const MAX_ATTACHMENT_BYTES = 256 * 1024;
const BINARY_SNIFF_BYTES = 8 * 1024;

// Local mirror of the ToolError from tools/files (the message is what matters).
class AttachmentPathError extends Error {}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Removes all occurrences of the char at the ends (Python's strip(ch)). */
function stripChar(s: string, ch: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && s[start] === ch) start++;
  while (end > start && s[end - 1] === ch) end--;
  return s.slice(start, end);
}

/** Same containment rules as tools/files.py's resolve_path. */
function resolveContained(pathArg: string): string {
  const abs = path.isAbsolute(pathArg) ? pathArg : path.join(config.root, pathArg);
  const p = realpathSafe(abs);
  const root = config.root;
  if (p !== root && !p.startsWith(root + path.sep)) {
    throw new AttachmentPathError(`access denied: '${pathArg}' is outside the project directory`);
  }
  // Single exception to the .reagent block: tool-output spills
  // are readable (dispatch points the model to .reagent/truncations).
  const spillDir = path.join(config.stateDir, "truncations");
  if (p === spillDir || p.startsWith(spillDir + path.sep)) return p;
  const relativeParts = path.relative(root, p).split(path.sep).filter(Boolean);
  if (relativeParts.some((part) => IGNORED_DIRS.has(part))) {
    throw new AttachmentPathError(`access denied: '${pathArg}' is inside a blocked directory`);
  }
  const name = path.basename(p);
  if (PROTECTED_FILES.has(name)) {
    throw new AttachmentPathError(`access denied: '${name}' is a protected file`);
  }
  return p;
}

/** Heuristic detection of binary content in the file's first bytes. */
function looksBinary(sample: Buffer): boolean {
  if (sample.includes(0)) return true; // NUL byte is the strongest binary signal
  if (sample.length === 0) return false;
  // A high proportion of control bytes (outside text) indicates binary.
  const textControl = new Set([0x09, 0x0a, 0x0c, 0x0d, 0x1b]); // tab, LF, FF, CR, ESC
  let nontext = 0;
  for (const b of sample) {
    if (b < 0x20 && !textControl.has(b)) nontext++;
  }
  return nontext / sample.length > 0.3;
}

const MAX_LINE_CHARS = 2000;

function clipLine(line: string): string {
  if (line.length <= MAX_LINE_CHARS) return line;
  return line.slice(0, MAX_LINE_CHARS) + "... (line truncated)";
}

/** Python's str.splitlines() for the common separators (\n, \r\n, \r). */
function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Same numbered output as tools/files.py's read_file (offset=1, limit=2000). */
function readFileNumbered(pathArg: string, offset = 1, limit = 2000): string {
  const p = resolveContained(pathArg);
  let raw: string;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch (e) {
    throw new AttachmentPathError(`failed to read ${pathArg}: ${errMsg(e)}`);
  }
  const lines = splitLines(raw);
  const start = Math.max(offset, 1);
  const chunk = lines.slice(start - 1, start - 1 + limit);
  if (chunk.length === 0) {
    return `(empty file or offset beyond end: ${lines.length} lines)`;
  }
  const numbered = chunk.map((line, i) => `${String(start + i).padStart(5)}\t${clipLine(line)}`);
  let suffix = "";
  if (start - 1 + limit < lines.length) {
    suffix = `\n... (${lines.length} lines total, use offset to continue)`;
  }
  return numbered.join("\n") + suffix;
}

/** Directory listing in list_dir's format (dirs first, filtered). */
function listDirText(resolved: string): string {
  const children = fs.readdirSync(resolved).map((name) => {
    let isDir = false;
    try {
      isDir = fs.statSync(path.join(resolved, name)).isDirectory();
    } catch {
      // broken symlink or no access: treated as a file
    }
    return { name, isDir };
  });
  children.sort((a, b) => {
    const ka = a.isDir ? 0 : 1;
    const kb = b.isDir ? 0 : 1;
    if (ka !== kb) return ka - kb;
    const na = a.name.toLowerCase();
    const nb = b.name.toLowerCase();
    return na < nb ? -1 : na > nb ? 1 : 0;
  });
  const entries: string[] = [];
  for (const child of children) {
    if (IGNORED_DIRS.has(child.name) || PROTECTED_FILES.has(child.name)) continue;
    entries.push(child.isDir ? `${child.name}/` : child.name);
  }
  return entries.join("\n") || "(empty directory)";
}

/** Converts a @path reference into text attachable to the prompt. */
export function attachReference(target: string): string {
  const p = stripChar(stripChar(target.trim(), '"'), "'");
  if (!p) return "";
  let resolved: string;
  try {
    resolved = resolveContained(p);
  } catch (e) {
    return `[invalid attachment @${p}: ${errMsg(e)}]`;
  }

  let st: fs.Stats | null = null;
  try {
    st = fs.statSync(resolved);
  } catch {
    st = null;
  }

  if (st?.isFile()) {
    const size = st.size;
    if (size > MAX_ATTACHMENT_BYTES) {
      const kb = Math.floor(size / 1024);
      return (
        `[attachment @${p} skipped: file too large (${kb} KB); ` +
        "ask me to read it with read_file]"
      );
    }
    let sample: Buffer;
    try {
      // reads via the already-resolved path (same protections as resolveContained)
      const fd = fs.openSync(resolved, "r");
      try {
        const buf = Buffer.alloc(BINARY_SNIFF_BYTES);
        const n = fs.readSync(fd, buf, 0, BINARY_SNIFF_BYTES, 0);
        sample = buf.subarray(0, n);
      } finally {
        fs.closeSync(fd);
      }
    } catch (e) {
      return `[invalid attachment @${p}: ${errMsg(e)}]`;
    }
    if (looksBinary(sample)) {
      return `[attachment @${p} skipped: looks binary]`;
    }
    let text: string;
    try {
      text = readFileNumbered(p);
    } catch (e) {
      return `[invalid attachment @${p}: ${errMsg(e)}]`;
    }
    return `\n\n[Attachment: file ${p}]\n${text}\n[/Attachment: file ${p}]`;
  }

  if (st?.isDirectory()) {
    const listing = listDirText(resolved);
    return `\n\n[Attachment: directory ${p}]\n${listing}\n[/Attachment: directory ${p}]`;
  }

  return `[invalid attachment @${p}: path not found]`;
}

/** Expands all @path references in the text. */
export function expand(text: string): string {
  return text.replace(ATTACHMENT_RE, (_m, target: string) => attachReference(target));
}
