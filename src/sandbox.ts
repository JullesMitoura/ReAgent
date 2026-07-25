/**
 * Port of src/sandbox.py: an OS sandbox for bash on macOS (Seatbelt, Codex's
 * workspace-write model).
 *
 * Non-dangerous commands run inside /usr/bin/sandbox-exec without asking for
 * permission: read of the whole disk, write only in the project ROOT and in the
 * temporaries. Escaping the sandbox requires explicit approval (tools/shell.ts).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { PROTECTED_FILES, config, realpathSafe } from "./config.js";

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
  const lines = [
    "(version 1)",
    "(deny default)",
    "(allow process-exec)",
    "(allow process-fork)",
    "(allow signal (target same-sandbox))",
    // Read of the whole disk, like Codex's workspace-write.
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

/** Small port of shutil.which for a single program name. */
function which(program: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, program);
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Argv of the shell that runs `command`: explicit bash, sh only as a last
 * resort.
 *
 * Inside and outside the sandbox the shell is the same (previously the approved
 * retry fell into shell=True's sh while the sandbox used bash).
 */
export function shellArgv(command: string): string[] {
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
