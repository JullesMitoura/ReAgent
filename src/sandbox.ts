/**
 * Port of src/sandbox.py: an OS sandbox for bash on macOS (Seatbelt, Codex's
 * workspace-write model).
 *
 * Known-safe (read-only) commands may run inside /usr/bin/sandbox-exec without
 * asking; non-safe commands always prompt first (tools/shell.ts). Write is
 * limited to the project ROOT and temporaries. Broad host reads remain for
 * tooling compatibility, with explicit denials for common secret locations
 * outside the workspace (.ssh, .aws, home .npmrc, …).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { PROTECTED_FILES, config, realpathSafe } from "./config.js";
import { which } from "./lib/which.js";

/** True when Seatbelt can be used: macOS + sandbox-exec + auto mode. */
export function available(): boolean {
  return (
    process.platform === "darwin" &&
    fs.existsSync("/usr/bin/sandbox-exec") &&
    config.sandboxMode === "auto"
  );
}

/** Escapes a path as an SBPL string (double quotes and backslashes). */
function quote(p: string): string {
  return '"' + p.replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"';
}

// Same set of characters that Python 3.7+'s re.escape escapes.
const REGEX_SPECIALS = new Set("()[]{}?*+-|^$\\.&~# \t\n\r\v\f");

/** Escapes s for literal use inside an SBPL regex #"..." (quotes included). */
export function regexQuote(s: string): string {
  let out = "";
  for (const ch of s) {
    if (REGEX_SPECIALS.has(ch)) out += "\\" + ch;
    else if (ch === '"') out += '\\"';
    else out += ch;
  }
  return out;
}

/**
 * SBPL policy closed by default, in Codex's workspace-write style.
 *
 * Seatbelt evaluates the already-resolved path (symlinks), so the subpaths use
 * realpath; /tmp also enters in literal form for safety. The .git/.reagent
 * denies come AFTER the allows: in SBPL the last rule that matches wins, so the
 * deny becomes a carveout inside the ROOT (same pattern as Codex; .git/hooks is
 * an escalation vector, .reagent is the agent's state). Secrets (.reagent and
 * PROTECTED_FILES) also have their read denied: a non-dangerous command runs
 * sandboxed without a prompt and cannot read .env.
 */
export function buildProfile(): string {
  const root = realpathSafe(String(config.root));
  const tmpdir = realpathSafe(os.tmpdir());
  const home = realpathSafe(os.homedir());
  const lines = [
    "(version 1)",
    "(deny default)",
    "(allow process-exec)",
    "(allow process-fork)",
    "(allow signal (target same-sandbox))",
    // Read of the whole disk, like Codex's workspace-write (tooling needs
    // /usr, SDKs, etc.). Sensitive home paths are denied below.
    "(allow file-read*)",
    `(allow file-write* (subpath ${quote(root)}))`,
    '(allow file-write* (subpath "/tmp"))',
    `(allow file-write* (subpath ${quote(realpathSafe("/tmp"))}))`,
    `(allow file-write* (subpath ${quote(tmpdir)}))`,
    '(allow file-write* (literal "/dev/null"))',
    '(allow file-write* (literal "/dev/tty"))',
    // Carveouts (deny after the allows, see docstring).
    `(deny file-write* (subpath ${quote(path.join(root, ".git"))}))`,
    `(deny file-write* (subpath ${quote(path.join(root, ".reagent"))}))`,
    `(deny file-read* (subpath ${quote(path.join(root, ".reagent"))}))`,
  ];
  // Host secret locations outside the project (defense in depth on top of
  // the non-safe permission gate in tools/shell.ts).
  for (const rel of [".ssh", ".aws", ".gnupg", ".config/gcloud", ".azure"]) {
    lines.push(`(deny file-read* (subpath ${quote(path.join(home, rel))}))`);
  }
  for (const name of [".npmrc", ".netrc", ".pgpass"]) {
    lines.push(`(deny file-read* (literal ${quote(path.join(home, name))}))`);
  }
  // Secrets: deny read and write of the PROTECTED_FILES in the ROOT and in any
  // subdirectory (same rationale as the carveouts: deny after the allows).
  for (const name of Array.from(PROTECTED_FILES).sort()) {
    const pattern = `^${regexQuote(root)}/(.*/)?${regexQuote(name)}$`;
    lines.push(`(deny file-read* (regex #"${pattern}"))`);
    lines.push(`(deny file-write* (regex #"${pattern}"))`);
  }
  lines.push(
    // Pragmatic: many CLIs break without sysctl-read and mach-lookup.
    "(allow sysctl-read)",
    "(allow mach-lookup)",
  );
  if (config.sandboxNetwork) {
    lines.push("(allow network*)");
  }
  return lines.join("\n");
}

/**
 * Well-known Git for Windows install locations for bash.exe, checked before
 * falling back to a PATH search. Git for Windows is the standard way to get a
 * POSIX shell + coreutils on Windows, and is what the safe/dangerous command
 * classifiers (command-safety.ts) assume (ls, cat, grep, sed, ... by name).
 */
function windowsBashCandidates(): string[] {
  const roots = [
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
    process.env.ProgramW6432,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs"),
  ].filter((p): p is string => Boolean(p));
  return roots.map((root) => path.join(root, "Git", "bin", "bash.exe"));
}

/** Locates a usable bash.exe on Windows: well-known Git-for-Windows paths, then PATH. */
function findWindowsBash(): string | null {
  for (const candidate of windowsBashCandidates()) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return which("bash.exe") ?? which("bash");
}

/**
 * Argv of the shell that runs `command`: explicit bash, sh only as a last
 * resort.
 *
 * Inside and outside the sandbox the shell is the same (previously the approved
 * retry fell into shell=True's sh while the sandbox used bash).
 *
 * Windows has no /bin/bash or /bin/sh; ReAgent relies on Git for Windows'
 * bundled bash.exe there (same coreutils the command-safety classifiers
 * assume). Throws a clear, actionable error when none is found instead of
 * silently building an argv that will ENOENT.
 */
export function shellArgv(command: string): string[] {
  if (process.platform === "win32") {
    const bash = findWindowsBash();
    if (!bash) {
      throw new Error(
        "No POSIX shell found. ReAgent's bash tool requires Git for Windows " +
          "(ships bash.exe): install it from https://git-scm.com/download/win, " +
          "make sure it's on PATH, then restart reagent.",
      );
    }
    return [bash, "-lc", command];
  }
  if (fs.existsSync("/bin/bash")) {
    return ["/bin/bash", "-lc", command];
  }
  const found = which("bash");
  if (found) {
    return [found, "-lc", command];
  }
  return ["/bin/sh", "-c", command];
}

/** Full argv to run `command` contained in Seatbelt. */
export function wrap(command: string): string[] {
  return ["/usr/bin/sandbox-exec", "-p", buildProfile(), ...shellArgv(command)];
}

/**
 * Conservative heuristic: only flags a denial with textual evidence.
 *
 * An exit != 0 alone is not enough (a broken test is not the sandbox); it
 * requires Seatbelt's typical mark in the output ("Operation not permitted", an
 * error from sandbox-exec itself, a sandboxd deny line or EPERM with exit 1).
 */
export function looksLikeDenial(exitCode: number | null, output: string): boolean {
  if (exitCode === 0) return false;
  const text = output || "";
  if (text.includes("Operation not permitted")) return true;
  if (text.includes("sandbox-exec")) return true;
  for (const line of text.split(/\r\n|\r|\n/)) {
    const lower = line.toLowerCase();
    if (lower.includes("deny") && lower.includes("sandbox")) return true;
  }
  if (exitCode === 1 && text.includes("EPERM")) return true;
  return false;
}
