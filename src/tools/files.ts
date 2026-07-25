/**
 * Port of src/tools/files.py: reading, writing, editing, deleting and listing
 * project files, with path guards and post-edit diagnostics.
 *
 * Python -> Node adaptations (section 4 of MIGRATION_SPEC):
 * - Path.resolve() becomes realpathSafe (realpath with parent + basename fallback)
 *   BEFORE the containment checks in ROOT (symlink escape);
 * - the global changes becomes currentTurn()?.changes (TurnContext);
 * - permissions.confirm_file is async, so write/edit/multi_edit/delete
 *   return Promise<string>;
 * - the diagnostics' subprocess.run becomes spawnSync with stdin "ignore" (DEVNULL).
 */

import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { recordEdit, recordRead } from "../agent/read-state.js";
import { config, IGNORED_DIRS, PROTECTED_FILES, realpathSafe } from "../config.js";
import { getCloseMatches } from "../lib/similarity.js";
import { diffPreview } from "../lib/text-diff.js";
import { confirmFile, denialMessage } from "../permissions.js";
import { noteChange } from "../project-context.js";
import { currentTurn } from "../turn-context.js";
import { findReplacement } from "./edit-cascade.js";
import { ArgumentError, ToolError } from "./errors.js";

// Test seam: test_diagnostics_uses_devnull_stdin swaps spawnSync to
// capture the options (equivalent of Python's subprocess.run monkeypatch).
export const _testHooks: { spawnSync: typeof spawnSync } = { spawnSync };

/** First executable found in PATH, or null (shutil.which). */
function which(cmd: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, cmd);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // keep searching
    }
  }
  return null;
}

/** Quick post-edit check; the result goes back to the LLM for self-correction. */
export function _diagnostics(p: string): string {
  const ext = path.extname(p);
  let cmd: string[];
  if (ext === ".py") {
    const python = which("python3") ?? which("python");
    if (python === null) return ""; // no python in PATH, no check
    cmd = [python, "-m", "py_compile", p];
  } else if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
    cmd = [process.execPath, "--check", p];
  } else {
    return "";
  }
  let proc: SpawnSyncReturns<string>;
  try {
    proc = _testHooks.spawnSync(cmd[0]!, cmd.slice(1), {
      stdio: ["ignore", "pipe", "pipe"], // stdin DEVNULL: the check never hangs reading input
      encoding: "utf8",
      timeout: 15_000,
    });
  } catch {
    return "";
  }
  // timeout/execution failure become a silent no-op, as in Python
  if (proc.error || proc.status === null) return "";
  if (proc.status !== 0) {
    const detail = ((proc.stderr || proc.stdout) ?? "").trim();
    return `\n[diagnostics] syntax check failed:\n${detail}`;
  }
  return "";
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function contains(parent: string, p: string): boolean {
  return p === parent || p.startsWith(parent + path.sep);
}

/** Resolves a path and ensures it stays inside the project. */
export function resolvePath(pathArg: string): string {
  const abs = path.isAbsolute(pathArg) ? pathArg : path.join(config.root, pathArg);
  const p = realpathSafe(abs);
  if (!contains(config.root, p)) {
    throw new ToolError(`access denied: '${pathArg}' is outside the project directory`);
  }
  // Single exception to the .reagent block: tool-output spills
  // (dispatch saves huge outputs to .reagent/truncations and points the model
  // there) are READABLE. Writing stays blocked by assertWritable.
  const spillDir = path.join(config.stateDir, "truncations");
  if (contains(spillDir, p)) return p;
  const relativeParts = path.relative(config.root, p).split(path.sep).filter(Boolean);
  if (relativeParts.some((part) => IGNORED_DIRS.has(part))) {
    throw new ToolError(`access denied: '${pathArg}' is inside a blocked directory`);
  }
  if (PROTECTED_FILES.has(path.basename(p))) {
    throw new ToolError(`access denied: '${path.basename(p)}' is a protected file`);
  }
  return p;
}

/**
 * Blocks creating/overwriting/deleting inside ReAgent's own source code.
 * A strong guarantee (not just prompt guidance); reading stays allowed (only
 * write/edit/delete pass through here). No-op when the agent works on another project.
 */
export function assertWritable(p: string): void {
  if (contains(config.stateDir, realpathSafe(p))) {
    // covers .reagent/truncations, which resolvePath allows for READING
    throw new ToolError("access denied: .reagent is the agent's own state and is read-only");
  }
  if (config.isAppSource(p)) {
    throw new ToolError(
      "access denied: ReAgent's own source (src/, ui/) is read-only; " +
        "put generated files in the project root or an output/ folder, not in the app source",
    );
  }
}

/**
 * Optimistic-concurrency guard against two concurrent writers silently
 * clobbering the same file. write_file/edit_file/multi_edit/delete_file (and
 * apply_patch) snapshot a file's bytes as `before`, then AWAIT a permission
 * confirmation that can take anywhere from instant (auto-approve) to minutes
 * (interactive prompt); only after that do they mutate the file. If another
 * agent, process or the user changed the file on disk in that window, writing
 * blind would silently discard that change with zero detection. Call this
 * right before the actual mutation (fs.writeFileSync/fs.unlinkSync), reusing
 * the same `before` snapshot already passed to changes.record.
 */
export function assertUnchangedOnDisk(p: string, before: Buffer | null): void {
  const rel = path.relative(config.root, p);
  if (before === null) {
    if (fs.existsSync(p)) {
      throw new ToolError(
        `file changed on disk since it was read: '${rel}' was created by another process/agent ` +
          "in the meantime; re-read it and retry",
      );
    }
    return;
  }
  let current: Buffer;
  try {
    current = fs.readFileSync(p);
  } catch {
    throw new ToolError(
      `file changed on disk since it was read: '${rel}' was deleted by another process/agent ` +
        "in the meantime; re-read it and retry",
    );
  }
  if (!current.equals(before)) {
    throw new ToolError(
      `file changed on disk since it was read: '${rel}' was modified by another process/agent ` +
        "in the meantime; re-read it and retry",
    );
  }
}

// cap per returned line: minified JS/JSON must not flood the context
const MAX_LINE_CHARS = 2000;

// cap on the diff preview shown in the write/edit/multi_edit confirmation
const PREVIEW_LINE_LIMIT = 60;

function clipLine(line: string): string {
  if (line.length <= MAX_LINE_CHARS) return line;
  return line.slice(0, MAX_LINE_CHARS) + "... (line truncated)";
}

/** Equivalent of Python's str.splitlines() (no trailing empty element). */
function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** "file not found", suggesting up to 3 close names from the same directory. */
function notFoundError(p: string, pathArg: string): ToolError {
  let msg = `file not found: ${pathArg}`;
  const parent = path.dirname(p);
  if (isDir(parent)) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(parent).filter((name) => isFile(path.join(parent, name)));
    } catch {
      names = [];
    }
    const close = getCloseMatches(path.basename(p), names, 3);
    if (close.length > 0) msg += `. Did you mean: ${close.join(", ")}?`;
  }
  return new ToolError(msg);
}

export function readFile(pathArg: string, offset = 1, limit = 2000): string {
  if (offset !== undefined && !(typeof offset === "number" && Number.isFinite(offset))) {
    throw new ArgumentError(`'offset' must be a number, got ${JSON.stringify(offset)}`);
  }
  if (limit !== undefined && !(typeof limit === "number" && Number.isFinite(limit))) {
    throw new ArgumentError(`'limit' must be a number, got ${JSON.stringify(limit)}`);
  }
  const p = resolvePath(pathArg);
  if (!isFile(p)) throw notFoundError(p, pathArg);
  let lines: string[];
  try {
    lines = splitLines(fs.readFileSync(p).toString("utf8"));
  } catch (e) {
    throw new ToolError(`failed to read ${pathArg}: ${e instanceof Error ? e.message : e}`);
  }
  recordRead(p);
  if (lines.length === 0) {
    return "<system-reminder>File exists but is empty.</system-reminder>";
  }
  const start = Math.max(offset, 1);
  if (start > lines.length) {
    return `Warning: offset ${offset} is past the end of the file (${lines.length} lines total). Re-read with a smaller offset.`;
  }
  const chunk = lines.slice(start - 1, start - 1 + limit);
  const numbered = chunk.map((line, i) => `${String(start + i).padStart(5)}\t${clipLine(line)}`);
  let suffix = "";
  if (start - 1 + limit < lines.length) {
    suffix = `\n... (${lines.length} lines total, use offset to continue)`;
  }
  return numbered.join("\n") + suffix;
}

export async function writeFile(pathArg: string, content: string): Promise<string> {
  const p = resolvePath(pathArg);
  assertWritable(p);
  const exists = fs.existsSync(p);
  const action = exists ? "overwrite" : "create";
  const rel = path.relative(config.root, p);
  const contentLines = splitLines(content);
  const beforeBuf = exists ? fs.readFileSync(p) : null;
  const preview = diffPreview(
    beforeBuf ? beforeBuf.toString("utf8") : "",
    content,
    exists ? rel : "/dev/null",
    rel,
    PREVIEW_LINE_LIMIT,
  );
  if (!(await confirmFile("write", `${action} file ${rel}`, rel, preview))) {
    // cancel/timeout swap the "User denied" for a neutral message
    return denialMessage("User denied write permission.");
  }
  // confirmFile can await user input for a long time; re-check the file was
  // not touched by another writer between the snapshot above and now.
  assertUnchangedOnDisk(p, beforeBuf);
  currentTurn()?.changes?.record(p, beforeBuf);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf8");
  recordEdit(p);
  // creating a file changes the structure and may invalidate the map (CONTEXT.md)
  noteChange(p, action === "create");
  const result =
    `File ${action === "overwrite" ? "overwritten" : "created"}: ` +
    `${rel} (${contentLines.length} lines)`;
  return result + _diagnostics(p);
}

export async function editFile(
  pathArg: string,
  oldString: string,
  newString: string,
  replaceAll = false,
): Promise<string> {
  const p = resolvePath(pathArg);
  assertWritable(p);
  if (!isFile(p)) throw new ToolError(`file not found: ${pathArg}`);
  const before = fs.readFileSync(p);
  const raw = before.toString("utf8");
  const newline = raw.includes("\r\n") ? "\r\n" : "\n";
  // Work in '\n' space (the cascade is newline-agnostic); the dominant
  // newline is re-emitted on write to never introduce mixed lines.
  const text = raw.replaceAll("\r\n", "\n");
  const old = oldString.replaceAll("\r\n", "\n");
  const neu = newString.replaceAll("\r\n", "\n");
  const [replacedText, replaced] = findReplacement(text, old, neu, replaceAll);
  const rel = path.relative(config.root, p);
  const preview = diffPreview(text, replacedText, rel, rel, PREVIEW_LINE_LIMIT);
  if (!(await confirmFile("edit", `edit file ${rel}`, rel, preview))) {
    return denialMessage("User denied edit permission.");
  }
  // confirmFile can await user input for a long time; re-check the file was
  // not touched by another writer between the snapshot above and now.
  assertUnchangedOnDisk(p, before);
  currentTurn()?.changes?.record(p, before);
  let newText = replacedText;
  if (newline !== "\n") newText = newText.replaceAll("\n", newline);
  fs.writeFileSync(p, newText, "utf8");
  recordEdit(p);
  // editing a tracked manifest/config (package.json, etc.) invalidates the map
  noteChange(p, false);
  return `Edited ${rel}: ${replaced} replacement(s)` + _diagnostics(p);
}

/** Applies several edits in sequence on the same file, all-or-nothing (a single write). */
export async function multiEdit(
  pathArg: string,
  edits: { old_string: string; new_string: string; replace_all?: boolean }[],
): Promise<string> {
  const p = resolvePath(pathArg);
  assertWritable(p);
  if (!isFile(p)) throw new ToolError(`file not found: ${pathArg}`);
  const rawEdits: unknown = edits;
  if (!Array.isArray(rawEdits) || rawEdits.length === 0) {
    throw new ToolError("edits must be a non-empty list of {old_string, new_string} objects");
  }
  const parsed: [string, string, boolean][] = [];
  for (let i = 1; i <= rawEdits.length; i++) {
    const edit: unknown = rawEdits[i - 1];
    if (typeof edit !== "object" || edit === null || Array.isArray(edit)) {
      throw new ToolError(`edit ${i}: expected an object with old_string and new_string`);
    }
    const dict = edit as Record<string, unknown>;
    const old = dict["old_string"];
    const neu = dict["new_string"];
    const replaceAll = "replace_all" in dict ? dict["replace_all"] : false;
    if (typeof old !== "string" || typeof neu !== "string") {
      throw new ToolError(`edit ${i}: old_string and new_string must both be strings`);
    }
    if (typeof replaceAll !== "boolean") {
      throw new ToolError(`edit ${i}: replace_all must be a boolean`);
    }
    parsed.push([old, neu, replaceAll]);
  }
  const before = fs.readFileSync(p);
  const raw = before.toString("utf8");
  const newline = raw.includes("\r\n") ? "\r\n" : "\n";
  // Same newline handling as editFile. Each edit operates on the result
  // of the previous one, all in memory; if any of them fails, nothing is written.
  const original = raw.replaceAll("\r\n", "\n");
  let text = original;
  let total = 0;
  for (let i = 1; i <= parsed.length; i++) {
    const [old, neu, replaceAll] = parsed[i - 1]!;
    try {
      const [next, replaced] = findReplacement(
        text,
        old.replaceAll("\r\n", "\n"),
        neu.replaceAll("\r\n", "\n"),
        replaceAll,
      );
      text = next;
      total += replaced;
    } catch (e) {
      if (e instanceof ToolError) {
        throw new ToolError(`edit ${i} of ${parsed.length}: ${e.message} (file left unchanged)`);
      }
      throw e;
    }
  }
  const rel = path.relative(config.root, p);
  // One combined diff of the net effect of all edits (not per-edit): closer to
  // what the user actually needs to review, and reuses the same renderer.
  const preview = diffPreview(original, text, rel, rel, PREVIEW_LINE_LIMIT);
  if (!(await confirmFile("edit", `edit file ${rel} (${parsed.length} edits)`, rel, preview))) {
    return denialMessage("User denied edit permission.");
  }
  // confirmFile can await user input for a long time; re-check the file was
  // not touched by another writer between the snapshot above and now.
  assertUnchangedOnDisk(p, before);
  currentTurn()?.changes?.record(p, before);
  if (newline !== "\n") text = text.replaceAll("\n", newline);
  fs.writeFileSync(p, text, "utf8");
  recordEdit(p);
  noteChange(p, false);
  return `Edited ${rel}: ${parsed.length} edits, ${total} replacement(s)` + _diagnostics(p);
}

/** Removes a project file (actually deletes, does not empty). */
export async function deleteFile(pathArg: string): Promise<string> {
  const p = resolvePath(pathArg);
  assertWritable(p);
  if (!fs.existsSync(p)) throw new ToolError(`file not found: ${pathArg}`);
  if (isDir(p)) {
    throw new ToolError(`'${pathArg}' is a directory; delete_file removes files only`);
  }
  // snapshot BEFORE the permission await (mirrors write/edit) so the
  // concurrency check below has something meaningful to compare against
  const before = fs.readFileSync(p);
  const rel = path.relative(config.root, p);
  if (!(await confirmFile("delete", `delete file ${rel}`, rel))) {
    return denialMessage("User denied delete permission.");
  }
  // confirmFile can await user input for a long time; re-check the file was
  // not touched by another writer between the snapshot above and now.
  assertUnchangedOnDisk(p, before);
  currentTurn()?.changes?.record(p, before);
  fs.unlinkSync(p);
  noteChange(p, true); // removal changes the structure
  return `Deleted ${rel}`;
}

export function listDir(pathArg = "."): string {
  const p = resolvePath(pathArg);
  if (!isDir(p)) throw new ToolError(`directory not found: ${pathArg}`);
  const children = fs.readdirSync(p).map((name) => ({
    name,
    dir: isDir(path.join(p, name)),
  }));
  // directories first, then case-insensitive ordering within each group
  children.sort((a, b) => {
    const ga = a.dir ? 0 : 1;
    const gb = b.dir ? 0 : 1;
    if (ga !== gb) return ga - gb;
    const la = a.name.toLowerCase();
    const lb = b.name.toLowerCase();
    return la < lb ? -1 : la > lb ? 1 : 0;
  });
  const entries: string[] = [];
  for (const child of children) {
    if (IGNORED_DIRS.has(child.name) || PROTECTED_FILES.has(child.name)) continue;
    entries.push(child.dir ? `${child.name}/` : child.name);
  }
  return entries.join("\n") || "(empty directory)";
}
