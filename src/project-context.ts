/**
 * Port of src/project_context.py: auto-generated project context
 * (`.reagent/CONTEXT.md`).
 *
 * On the first run in a directory (or when the project changes
 * structurally), generates a short CONTEXT.md describing the project. Cheap
 * generation: samples README, manifests, shallow tree and entry point
 * headers, never the whole repository. Staleness by signature in the
 * provenance header; lazy regeneration at the start of the next session.
 *
 * Lives in `.reagent/` (agent state): does not pollute the user's repository
 * nor overwrite a hand-written AGENTS.md/CLAUDE.md.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { config, IGNORED_DIRS, PROTECTED_FILES, realpathSafe } from "./config.js";
import { chat } from "./llm/client.js";
import { getLogger } from "./logs.js";
import type { ChatMessage, EmitFn } from "./types.js";

const log = getLogger("project-context");

// Bump to force regeneration of every CONTEXT.md when the format/prompt changes.
export const GENERATOR_VERSION = 2;

// Effective version used at runtime; ESM exports are not monkeypatchable, so
// the tests simulate a bump via _setGeneratorVersion (test hook).
let generatorVersion: number = GENERATOR_VERSION;

/** Test hook: simulates bumping/restoring the generator version. */
export function _setGeneratorVersion(v: number): void {
  generatorVersion = v;
}

const MAX_CONTEXT_CHARS = 8_000; // cap on the generated body
const MAX_SIGNAL_CHARS = 20_000; // cap on the sampled material sent to the generator

// Source files whose change invalidates CONTEXT.md (staleness by signature)
// and that are also sampled during generation (high signal per token).
const TRACKED: readonly string[] = [
  "README.md", "README.rst", "README.txt",
  "package.json", "pyproject.toml", "requirements.txt", "setup.py", "setup.cfg",
  "Cargo.toml", "go.mod", "pom.xml", "build.gradle", "Gemfile", "composer.json",
  "tsconfig.json", "vite.config.ts", "vite.config.js", "next.config.js",
  "Makefile", "justfile", "Dockerfile", "docker-compose.yml",
  "AGENTS.md", "CLAUDE.md",
];

// Common entry point candidates: only the header is read to classify the project.
const ENTRY_CANDIDATES: readonly string[] = [
  "main.py", "app.py", "manage.py", "src/main.py", "src/__main__.py",
  "src/App.tsx", "src/main.tsx", "src/index.tsx", "src/index.ts", "src/index.js",
  "code-front/src/App.tsx", "index.html", "src/index.html", "Cargo.toml",
];

const GEN_SYSTEM =
  "You write a terse project brief for AI coding agents (like a CLAUDE.md / AGENTS.md). " +
  "Record only what an agent cannot cheaply infer from the code. Be dense and factual: " +
  "short bullet fragments, not prose. Do not invent facts; omit anything the material " +
  "does not support. Never exceed ~150 lines.";

const GEN_TEMPLATE = `From the sampled project material above, write CONTEXT.md with EXACTLY these sections (keep every header; write "(unknown)" if the material does not support it). Be terse.

## Project
- One or two sentences: what this project is and who/what it is for.

## Stack
- Language(s), framework(s), package manager (infer from lockfiles/manifests), runtime.

## Commands
- install / build / run / test \u2014 copied VERBATIM from package.json scripts, Makefile, or configs. Do NOT invent commands.

## Layout
- The 3-8 most important directories, one line each (what lives there).

## Entry points
- The files that ARE the app (main modules, App root, server bootstrap, routers).

## Do not touch
- Existing load-bearing files an agent must NOT overwrite wholesale: the entry points above, generated code, migrations, lockfiles, build output. List them by path.

## New files go
- Where NEW or standalone deliverables belong. IMPORTANT: a standalone deliverable (e.g. an HTML game or demo) MUST be a NEW self-contained file (a single .html), placed OUTSIDE the app's source (project root or an examples/ or output/ folder) \u2014 never by overwriting an existing entry point.

## Conventions
- Only conventions that differ from language defaults (style, naming, patterns to imitate). Otherwise "(none)".`;

// --- paths and helpers -------------------------------------------------------

function contextPath(): string {
  return path.join(config.stateDir, "CONTEXT.md");
}

function staleFlag(): string {
  return path.join(config.stateDir, "CONTEXT.stale");
}

/** Equivalent of Path.is_file() (follows symlink), without throwing. */
function isFileSync(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Containment in ROOT via realpath (Python's Path.resolve().is_relative_to). */
function withinRoot(p: string): boolean {
  try {
    const rp = realpathSafe(p);
    return rp === config.root || rp.startsWith(config.root + path.sep);
  } catch {
    return false;
  }
}

/**
 * Real file inside the sandbox: same guarantee as the tools (resolvePath),
 * without following a symlink pointing outside the project (e.g. README.md -> /etc/passwd).
 * lstat does not follow the link, so isFile() already excludes symlinks.
 */
export function _safeFile(p: string): boolean {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(p);
  } catch {
    return false;
  }
  return st.isFile() && withinRoot(p);
}

/** Python's str.splitlines() for the common separators. */
function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split(/\r\n|\n|\r/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function readHead(p: string, maxLines: number, maxChars = 4_000): string {
  if (!_safeFile(p)) return "";
  let text: string;
  try {
    text = fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
  return splitLines(text).slice(0, maxLines).join("\n").slice(0, maxChars);
}

// --- sampling ---------------------------------------------------------------

interface TreeEntry {
  name: string;
  full: string;
  isDir: boolean;
  isLink: boolean;
}

function listEntries(d: string): TreeEntry[] | null {
  let names: string[];
  try {
    names = fs.readdirSync(d);
  } catch {
    return null;
  }
  return names.map((name) => {
    const full = path.join(d, name);
    let isDir = false;
    try {
      isDir = fs.statSync(full).isDirectory(); // follows symlink, like Path.is_dir()
    } catch {
      isDir = false;
    }
    let isLink = false;
    try {
      isLink = fs.lstatSync(full).isSymbolicLink();
    } catch {
      isLink = false;
    }
    return { name, full, isDir, isLink };
  });
}

/** Shallow tree (depth <= 2), skipping ignored and hidden directories. */
function tree(root: string, maxEntries = 120): string {
  const lines: string[] = [];

  const walk = (d: string, depth: number, prefix: string): void => {
    if (depth > 2 || lines.length >= maxEntries) return;
    const entries = listEntries(d);
    if (entries === null) return;
    // dirs first, then lowercase name (same key as Python)
    entries.sort((a, b) => {
      const ka = a.isDir ? 0 : 1;
      const kb = b.isDir ? 0 : 1;
      if (ka !== kb) return ka - kb;
      const la = a.name.toLowerCase();
      const lb = b.name.toLowerCase();
      return la < lb ? -1 : la > lb ? 1 : 0;
    });
    for (const e of entries) {
      if (lines.length >= maxEntries) return;
      if (IGNORED_DIRS.has(e.name) || PROTECTED_FILES.has(e.name) || e.name.startsWith(".")) {
        continue;
      }
      if (e.isLink) continue; // does not follow or list symlinks (they could point outside)
      lines.push(`${prefix}${e.name}${e.isDir ? "/" : ""}`);
      if (e.isDir) walk(e.full, depth + 1, prefix + "  ");
    }
  };

  walk(root, 0, "");
  return lines.join("\n");
}

/** Cheap sample of high-value signals (never the whole repo). */
export function _gatherSignals(): string {
  const root = config.root;
  const parts: string[] = [
    `# Project root: ${path.basename(root)}`,
    "\n## Directory tree (depth<=2)\n" + tree(root),
  ];
  for (const name of TRACKED) {
    const p = path.join(root, name);
    if (_safeFile(p)) {
      parts.push(`\n## ${name}\n` + readHead(p, 150));
    }
  }
  // manifests in immediate subprojects (e.g. code-front/package.json): captures
  // build/test commands of fronts/monorepos that do not live at the root.
  const nested = ["package.json", "pyproject.toml", "Makefile", "Cargo.toml", "go.mod"];
  const topEntries = listEntries(root);
  if (topEntries !== null) {
    topEntries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const d of topEntries) {
      if (!d.isDir || IGNORED_DIRS.has(d.name) || d.name.startsWith(".")) continue;
      if (d.isLink) continue;
      for (const mname of nested) {
        const mp = path.join(d.full, mname);
        if (_safeFile(mp)) {
          parts.push(`\n## ${d.name}/${mname}\n` + readHead(mp, 60, 2_000));
        }
      }
    }
  }
  const seen = new Set<string>();
  for (const rel of ENTRY_CANDIDATES) {
    const p = path.join(root, rel);
    if (_safeFile(p) && !seen.has(p)) {
      seen.add(p);
      parts.push(`\n## entry head: ${rel}\n` + readHead(p, 40, 1_500));
    }
  }
  return parts.join("\n").slice(0, MAX_SIGNAL_CHARS);
}

// --- signature and staleness ---------------------------------------------------

function sha1Hex12(data: Buffer | string): string {
  return crypto.createHash("sha1").update(data).digest("hex").slice(0, 12);
}

/**
 * Cheap project signature: hash of the tracked manifests + top-level
 * structure. A change here (dependencies, commands, top-level folders)
 * invalidates CONTEXT.md.
 */
function signature(): Record<string, string> {
  const sig: Record<string, string> = {};
  for (const name of TRACKED) {
    const p = path.join(config.root, name);
    if (_safeFile(p)) {
      try {
        sig[name] = sha1Hex12(fs.readFileSync(p));
      } catch {
        // unreadable: left out of the signature
      }
    }
  }
  try {
    const top = fs
      .readdirSync(config.root)
      .filter((name) => !IGNORED_DIRS.has(name) && !name.startsWith("."))
      .map((name) => {
        let isDir = false;
        try {
          isDir = fs.statSync(path.join(config.root, name)).isDirectory();
        } catch {
          isDir = false;
        }
        return name + (isDir ? "/" : "");
      })
      .sort();
    sig["__top__"] = sha1Hex12(top.join("\n"));
  } catch {
    // unreadable root: partial signature
  }
  return sig;
}

export function _readMeta(): Record<string, unknown> | null {
  const p = contextPath();
  if (!isFileSync(p)) return null;
  let text: string;
  try {
    text = fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
  const lines = splitLines(text);
  if (!lines.length) return null;
  const line = lines[0] as string;
  const prefix = "<!-- reagent:context ";
  const suffix = " -->";
  if (!line.startsWith(prefix) || !line.endsWith(suffix)) return null;
  let data: unknown;
  try {
    data = JSON.parse(line.slice(prefix.length, line.length - suffix.length));
  } catch {
    return null;
  }
  // a hand-edited header may be valid scalar JSON ("x", 5, true);
  // only an object works as metadata (otherwise isStale would read a field on a scalar)
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  return data as Record<string, unknown>;
}

/**
 * True if CONTEXT.md must be regenerated NOW.
 *
 * Two classes of change, with different urgencies:
 * - a manifest changed (dependencies, commands): the map is now wrong, regenerate immediately;
 * - only the top-level structure changed (file created/deleted) or the stale flag was
 *   set: the map is still mostly valid, so it respects a cooldown
 *   (config.contextCooldownHours) to avoid rewriting on every conversation in which the
 *   agent creates a file.
 */
export function isStale(): boolean {
  if (!isFileSync(contextPath())) return true;
  const meta = _readMeta();
  if (!meta || meta["v"] !== generatorVersion) return true;
  const sigNow = signature();
  const rawSig: unknown = meta["sig"] ? meta["sig"] : {};
  if (typeof rawSig !== "object" || rawSig === null || Array.isArray(rawSig)) return true;
  const sigOld = rawSig as Record<string, unknown>;
  const manifestKeys = new Set([...Object.keys(sigOld), ...Object.keys(sigNow)]);
  manifestKeys.delete("__top__");
  for (const k of manifestKeys) {
    if (sigOld[k] !== sigNow[k]) return true;
  }
  const structural = sigOld["__top__"] !== sigNow["__top__"] || fs.existsSync(staleFlag());
  if (!structural) return false;
  const generatedAt = Number(meta["generated_at"] ?? 0) || 0;
  const age = Date.now() / 1000 - generatedAt;
  return age > config.contextCooldownHours * 3600;
}

/** Marks for regeneration in the NEXT session (does not regenerate mid-work). */
export function markStale(): void {
  try {
    fs.mkdirSync(config.stateDir, { recursive: true });
    fs.closeSync(fs.openSync(staleFlag(), "a"));
  } catch {
    // best effort
  }
}

/**
 * Called by the write tools: marks stale when the change affects the
 * map (file creation/removal, or change to a tracked manifest/config).
 * Ordinary edits to source code do not touch CONTEXT.md.
 */
export function noteChange(p: string, structural: boolean): void {
  if (!config.contextFile || !isFileSync(contextPath())) return;
  if (structural || TRACKED.includes(path.basename(p))) markStale();
}

// --- generation ------------------------------------------------------------------

/** Minimal shape of the non-streaming response used by the generator (faked in tests). */
export interface GenerateResponse {
  choices?: ({ message?: { content?: string | null } | null } | null)[] | null;
}

/** Injectable LLM call: the tests pass a fake; the default uses llm/client. */
export type GenerateFn = (messages: ChatMessage[]) => Promise<GenerateResponse>;

const defaultGenerateFn: GenerateFn = async (messages) =>
  (await chat(messages, null, false)) as unknown as GenerateResponse;

/**
 * Generates (or regenerates) CONTEXT.md from sampled signals. Never throws;
 * returns the generated body, or null if disabled/no material/error.
 */
export async function generate(
  emit: EmitFn | null = null,
  generateFn: GenerateFn = defaultGenerateFn,
): Promise<string | null> {
  if (!config.contextFile) return null;
  // practically empty directory (no tree, no manifests): nothing useful to summarize
  const hasTree = tree(config.root).trim() !== "";
  const hasManifest = TRACKED.some((n) => _safeFile(path.join(config.root, n)));
  if (!hasTree && !hasManifest) return null;
  const signals = _gatherSignals();
  if (emit) emit({ type: "status", text: "mapping project (generating CONTEXT.md)..." });
  const messages: ChatMessage[] = [
    { role: "system", content: GEN_SYSTEM },
    { role: "user", content: signals + "\n\n---\n" + GEN_TEMPLATE },
  ];
  let body: string;
  try {
    const resp = await generateFn(messages);
    body = (resp.choices?.[0]?.message?.content ?? "").trim();
  } catch (exc) {
    // context generation never breaks a turn
    log.warning("context: generation failed (%s)", exc instanceof Error ? exc.constructor.name : String(exc));
    return null;
  }
  if (!body) return null;
  body = body.slice(0, MAX_CONTEXT_CHARS);
  const header =
    "<!-- reagent:context " +
    JSON.stringify({
      v: generatorVersion,
      generated_at: Math.floor(Date.now() / 1000),
      sig: signature(),
    }) +
    " -->";
  try {
    fs.mkdirSync(config.stateDir, { recursive: true });
    fs.writeFileSync(contextPath(), header + "\n" + body + "\n", "utf8");
    fs.rmSync(staleFlag(), { force: true });
  } catch (exc) {
    log.warning("context: could not write CONTEXT.md (%s)", exc instanceof Error ? exc.message : String(exc));
    return null;
  }
  log.info("context: CONTEXT.md generated (%d chars)", body.length);
  return body;
}

/** At the start of the session: (re)generates CONTEXT.md if missing or stale. */
export async function ensure(
  emit: EmitFn | null = null,
  generateFn: GenerateFn = defaultGenerateFn,
): Promise<void> {
  if (!config.contextFile) return;
  try {
    if (isStale()) await generate(emit, generateFn);
  } catch (exc) {
    // defensive: never blocks the turn
    log.warning("context: ensure failed (%s)", exc instanceof Error ? exc.constructor.name : String(exc));
  }
}

/** CONTEXT.md body (without the provenance header), to inject into the prompt. */
export function load(): string {
  if (!config.contextFile) return "";
  const p = contextPath();
  if (!isFileSync(p)) return "";
  let text: string;
  try {
    text = fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
  let lines = splitLines(text);
  if (lines.length && (lines[0] as string).startsWith("<!-- reagent:context ")) {
    lines = lines.slice(1);
  }
  return lines.join("\n").trim();
}
