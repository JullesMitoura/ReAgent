/**
 * Port of src/tools/search.py: glob and grep restricted to ROOT.
 *
 * - Custom fnmatch (lib/fnmatch) for the patterns: "*" crosses "/" like in
 *   Python; the glob matches the relative path OR the basename.
 * - Symlinks only appear if the realpath of the target stays under ROOT (same
 *   guard as resolve_path); a broken symlink is skipped.
 * - IGNORED_DIRS are pruned in the walk; PROTECTED_FILES never appear.
 */

import fs from "node:fs";
import path from "node:path";

import { config, IGNORED_DIRS, PROTECTED_FILES, realpathSafe } from "../config.js";
import { fnmatch } from "../lib/fnmatch.js";
import { ArgumentError, ToolError } from "./errors.js";

// Result cap aligned with opencode (grep/glob cap at 100 with a note):
// 100 hits are enough to locate; more than that is noise paid for in tokens.
export const MAX_RESULTS = 100;

// grep reads each whole file into memory; giant artifacts (logs, bundles,
// dumps) would blow up RAM and time with no search value. Files above the cap
// are skipped, like binaries.
export const MAX_GREP_FILE_BYTES = 2_000_000;

/**
 * Local copy of resolve_path from files.py (tools/files.ts is a future phase;
 * when it exists, this helper can be swapped for the import). Realpath BEFORE
 * the containment checks, read exception for .reagent/truncations.
 */
function resolveBase(input: string): string {
  const abs = path.isAbsolute(input) ? input : path.join(config.root, input);
  const p = realpathSafe(abs);
  if (p !== config.root && !p.startsWith(config.root + path.sep)) {
    throw new ToolError(`access denied: '${input}' is outside the project directory`);
  }
  const spillDir = path.join(config.stateDir, "truncations");
  if (p === spillDir || p.startsWith(spillDir + path.sep)) return p;
  const relParts = path.relative(config.root, p).split(path.sep).filter((s) => s.length > 0);
  if (relParts.some((part) => IGNORED_DIRS.has(part))) {
    throw new ToolError(`access denied: '${input}' is inside a blocked directory`);
  }
  const name = path.basename(p);
  if (PROTECTED_FILES.has(name)) {
    throw new ToolError(`access denied: '${name}' is a protected file`);
  }
  return p;
}

/**
 * Mirror of Python's os.walk(followlinks=False): top-down, files of the
 * directory before the subdirectories, IGNORED_DIRS pruned, PROTECTED_FILES
 * skipped. A symlink only passes if the realpath of the target stays under ROOT.
 */
function* iterFiles(base: string): Generator<string> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return; // unreadable directory: os.walk also stays silent
  }
  const subdirs: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) subdirs.push(entry.name);
      continue;
    }
    const p = path.join(base, entry.name);
    if (entry.isSymbolicLink()) {
      // symlink to a directory: os.walk puts it in dirnames and, without
      // followlinks, does not descend into it; it never becomes a listed file
      let targetIsDir = false;
      try {
        targetIsDir = fs.statSync(p).isDirectory();
      } catch {
        continue; // broken symlink: skipped
      }
      if (targetIsDir) continue;
      if (PROTECTED_FILES.has(entry.name)) continue;
      // the real target must stay inside the sandbox (escape via symlink)
      let real: string;
      try {
        real = fs.realpathSync(p);
      } catch {
        continue; // unresolvable target
      }
      if (real !== config.root && !real.startsWith(config.root + path.sep)) continue;
      yield p;
      continue;
    }
    if (PROTECTED_FILES.has(entry.name)) continue;
    yield p;
  }
  for (const name of subdirs) {
    yield* iterFiles(path.join(base, name));
  }
}

// Safety cap on how many matches are collected before sorting by mtime and
// truncating to MAX_RESULTS; keeps a broad pattern (e.g. "*") from buffering
// an unbounded list on a huge tree.
const GLOB_COLLECT_CAP = 5_000;

/**
 * Tool glob: matches fnmatch against the relative path OR the basename,
 * returned most-recently-modified first (mirrors Claude Code's Glob, which is
 * commonly used to find "what changed most recently").
 */
export function globFiles(pattern: string): string {
  const matches: { rel: string; mtimeMs: number }[] = [];
  let truncatedScan = false;
  for (const p of iterFiles(config.root)) {
    const rel = path.relative(config.root, p);
    if (fnmatch(rel, pattern) || fnmatch(path.basename(p), pattern)) {
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(p).mtimeMs;
      } catch {
        // file vanished mid-walk; keep it, sorts as oldest
      }
      matches.push({ rel, mtimeMs });
      if (matches.length >= GLOB_COLLECT_CAP) {
        truncatedScan = true;
        break;
      }
    }
  }
  matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const out = matches.slice(0, MAX_RESULTS).map((m) => m.rel);
  if (matches.length > MAX_RESULTS || truncatedScan) {
    out.push(`... (limit of ${MAX_RESULTS} results)`);
  }
  return out.join("\n") || "(no files found)";
}

/** Tool grep: line-by-line regex over text files under ROOT. */
export function grep(pattern: string, searchPath = ".", include: string | null = null): string {
  if (typeof pattern !== "string") {
    // new RegExp() would silently coerce a non-string via .toString() (e.g. an
    // object becomes the literal "[object Object]") and compile a nonsense
    // regex that matches the wrong things instead of erroring
    throw new ArgumentError(`'pattern' must be a string, got ${typeof pattern}`);
  }
  let rx: RegExp;
  try {
    rx = new RegExp(pattern);
  } catch (e) {
    throw new ToolError(`invalid regex: ${e instanceof Error ? e.message : String(e)}`);
  }
  const base = resolveBase(searchPath);
  if (!fs.existsSync(base)) {
    throw new ToolError(`path not found: ${searchPath}`);
  }
  const files: Iterable<string> = fs.statSync(base).isFile() ? [base] : iterFiles(base);
  const results: string[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (const p of files) {
    if (include && !fnmatch(path.basename(p), include)) continue;
    let text: string;
    try {
      if (fs.statSync(p).size > MAX_GREP_FILE_BYTES) {
        continue; // giant artifact (log/bundle/dump), skipped like a binary
      }
      text = decoder.decode(fs.readFileSync(p)); // fatal: a binary throws and is skipped
    } catch {
      continue; // binary or unreadable file
    }
    // Python's splitlines: "" has no lines; no empty line after the last \n
    const lines = text === "" ? [] : text.split(/\r\n|\r|\n/);
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      if (rx.test(line)) {
        const rel = path.relative(config.root, p);
        results.push(`${rel}:${i + 1}: ${line.trim().slice(0, 200)}`);
        if (results.length >= MAX_RESULTS) {
          results.push(`... (limit of ${MAX_RESULTS} results)`);
          return results.join("\n");
        }
      }
    }
  }
  return results.join("\n") || "(no matches found)";
}
