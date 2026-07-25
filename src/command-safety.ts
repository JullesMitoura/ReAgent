// Bash command classification (port of src/command_safety.py, inspired by the
// Codex CLI). Two classifiers independent of the permission flow:
// - isSafeCommand: true only for provably read-only commands. Fail-closed.
// - isDangerousCommand: true for known destructive commands; only flags a
//   pattern actually detected, so it does not become noise.

import path from "node:path";

import { PROTECTED_FILES } from "./config.js";
import { tokenize } from "./lib/shell-tokenizer.js";

// Maximum unwrap depth (bash -c, sudo, env, ...).
const MAX_DEPTH = 8;

// Characters treated as punctuation (shell operators).
const OPERATOR_CHARS = new Set("();<>|&");

// Chaining operators accepted in safe compound commands.
const SAFE_OPERATORS = new Set(["&&", "||", ";", "|"]);

// Always-safe executables (read-only, no side effects).
const ALWAYS_SAFE = new Set([
  "basename", "cat", "cd", "cut", "date", "df", "dirname", "du",
  "echo", "expr", "false", "file", "grep", "head", "id", "less",
  "ls", "more", "nl", "paste", "printf", "pwd", "readlink",
  "realpath", "rev", "seq", "sort", "stat", "tail", "tr", "true",
  "uname", "uniq", "wc", "which", "whoami",
]);

// Shells whose inner script (-c / -lc) is evaluated recursively.
const SHELLS = new Set(["bash", "sh", "zsh"]);

// Git subcommands accepted in read-only form.
const GIT_SAFE_SUBS = new Set(["status", "log", "diff", "show", "branch"]);

// Git branch flags that write (delete, move, create, configure).
const GIT_BRANCH_DENY = new Set([
  "-d", "-D", "-m", "-M", "-c", "-C", "-f", "--force", "--delete",
  "--move", "--copy", "-u", "--set-upstream-to", "--unset-upstream",
  "--edit-description", "--create-reflog", "-t", "--track",
]);

// find actions that execute or write.
const FIND_DENY = new Set([
  "-exec", "-execdir", "-ok", "-okdir", "-delete",
  "-fls", "-fprint", "-fprint0", "-fprintf",
]);

// NAME=value assignment; [^\n] mirrors the "." of Python's fullmatch.
const ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=[^\n]*$/;

// Trusted system directories: only paths from here get reduced to a basename on
// the SAFE side (/bin/ls becomes ls). Fail-closed for the rest: ./cat or
// /usr/local/bin/ls could be arbitrary binaries and do not enter the safelist.
const TRUSTED_BIN_DIRS = new Set(["/bin", "/usr/bin"]);

// Basename only for executables in trusted system directories.
function normalizeSafeHead(head: string): string {
  if (TRUSTED_BIN_DIRS.has(path.posix.dirname(head))) return path.posix.basename(head);
  return head;
}

function stripBackticks(s: string): string {
  return s.replace(/^`+/, "").replace(/`+$/, "");
}

function isOperator(token: string): boolean {
  return token.length > 0 && [...token].every((c) => OPERATOR_CHARS.has(c));
}

// Split the token list into segments at operator tokens.
function splitSegments(tokens: string[]): string[][] {
  const segments: string[][] = [];
  let current: string[] = [];
  for (const tok of tokens) {
    if (isOperator(tok)) {
      segments.push(current);
      current = [];
    } else {
      current.push(tok);
    }
  }
  segments.push(current);
  return segments;
}

// ---------------------------------------------------------------------------
// isSafeCommand
// ---------------------------------------------------------------------------

// True only for provably read-only commands. Fail-closed.
export function isSafeCommand(command: string): boolean {
  return isSafe(command, 0);
}

function isSafe(command: string, depth: number): boolean {
  if (depth > MAX_DEPTH) return false;
  const cmd = command.trim();
  if (!cmd) return false;
  // Redirection, command substitution or newline: never safe, even inside
  // quotes (fail-closed).
  for (const bad of [">", "<", "`", "$(", "\n", "\r"]) {
    if (cmd.includes(bad)) return false;
  }
  let tokens: string[];
  try {
    tokens = tokenize(cmd);
  } catch {
    // Unbalanced quotes: not safe.
    return false;
  }
  // Only &&, ||, ; and | may chain; any other operator fails.
  for (const tok of tokens) {
    if (isOperator(tok) && !SAFE_OPERATORS.has(tok)) return false;
  }
  // Protected files: a command that references .env (or the agent state in
  // .reagent) never enters the safelist, even when read-only; an
  // auto-approved "cat .env" would leak secrets into the model context.
  for (const tok of tokens) {
    if (isOperator(tok)) continue;
    const parts = tok.split("/");
    const last = parts[parts.length - 1] as string;
    if (PROTECTED_FILES.has(last) || parts.includes(".reagent")) return false;
  }
  return splitSegments(tokens).every((seg) => isSafeSegment(seg, depth));
}

function isSafeSegment(tokens: string[], depth: number): boolean {
  if (tokens.length === 0) {
    // Empty segment (leftover operator): not safe.
    return false;
  }
  // /bin/ls and /usr/bin/ls count as ls; an untrusted path stays intact.
  const head = normalizeSafeHead(tokens[0] as string);
  const args = tokens.slice(1);
  // bash -c 'script': safe if the inner script is safe.
  if (SHELLS.has(head)) {
    if (tokens.length === 3 && (tokens[1] === "-c" || tokens[1] === "-lc")) {
      return isSafe(tokens[2] as string, depth + 1);
    }
    return false;
  }
  if (ALWAYS_SAFE.has(head)) return true;
  if (head === "env") {
    // env is only safe with no command: just NAME=value assignments.
    return args.every((a) => ASSIGN_RE.test(a));
  }
  if (head === "base64") return safeBase64(args);
  if (head === "find") return args.every((a) => !FIND_DENY.has(a));
  if (head === "rg") return safeRg(args);
  if (head === "git") return safeGit(args);
  if (head === "sed") return safeSed(tokens);
  return false;
}

function safeBase64(args: string[]): boolean {
  for (const a of args) {
    if (a.startsWith("--output")) return false;
    // Cluster of short flags containing 'o' (-o, -do, ...).
    if (a.startsWith("-") && !a.startsWith("--") && a.slice(1).includes("o")) return false;
  }
  return true;
}

function safeRg(args: string[]): boolean {
  for (const a of args) {
    if (a === "--search-zip" || a.startsWith("--pre") || a.startsWith("--hostname-bin")) {
      return false;
    }
    // -z (search-zip) including in a cluster of short flags.
    if (a.startsWith("-") && !a.startsWith("--") && a.slice(1).includes("z")) return false;
  }
  return true;
}

function safeGit(args: string[]): boolean {
  if (args.length === 0) return false;
  const sub = args[0] as string;
  const rest = args.slice(1);
  if (!GIT_SAFE_SUBS.has(sub)) return false;
  for (const a of rest) {
    // --output writes to a file (log, diff, show).
    if (a.startsWith("--output")) return false;
  }
  if (sub === "branch") {
    for (const a of rest) {
      if (GIT_BRANCH_DENY.has(a) || a.startsWith("--set-upstream-to=")) return false;
      // A positional can create a branch: only listing flags pass.
      if (!a.startsWith("-")) return false;
    }
  }
  return true;
}

function safeSed(tokens: string[]): boolean {
  // Only the restricted pattern: sed -n {N|M,N}p [file], max 4 tokens.
  if ((tokens.length !== 3 && tokens.length !== 4) || tokens[1] !== "-n") return false;
  return /^\d+(,\d+)?p$/.test(tokens[2] as string);
}

// ---------------------------------------------------------------------------
// isDangerousCommand
// ---------------------------------------------------------------------------

// True for known destructive commands (rm -rf, git reset --hard, ...).
export function isDangerousCommand(command: string): boolean {
  return isDangerous(command, 0);
}

function isDangerous(command: string, depth: number): boolean {
  if (depth > MAX_DEPTH) return false;
  let tokens: string[];
  try {
    tokens = tokenize(command.trim());
  } catch {
    // Fail-closed: unparseable/obfuscated commands must not skip the
    // dangerous gate (auto-approve / sandbox-first) by looking "unknown".
    return true;
  }
  return splitSegments(tokens).some((seg) => isDangerousSegment(seg, depth));
}

// Skip leading flags (and the value of those that take a value).
function skipFlags(args: string[], valueFlags: readonly string[] = []): string[] {
  let i = 0;
  while (i < args.length && (args[i] as string).startsWith("-") && args[i] !== "-") {
    i += valueFlags.includes(args[i] as string) ? 2 : 1;
  }
  return args.slice(i);
}

function isDangerousSegment(tokens: string[], depth: number): boolean {
  // Unwrap wrappers (sudo, env, nohup, time, timeout, xargs, shells) up to the
  // maximum depth, looking for the real command.
  let hops = 0;
  let toks = tokens;
  while (toks.length > 0 && depth + hops <= MAX_DEPTH) {
    // Unconditional basename on the dangerous side: /bin/rm, /usr/bin/env and
    // ./rm count as the command; a false positive here only causes a prompt.
    const head = path.posix.basename(stripBackticks(toks[0] as string));
    if (head === "sudo") {
      toks = skipFlags(toks.slice(1), ["-u", "--user"]);
      hops += 1;
      continue;
    }
    if (head === "nohup" || head === "time") {
      toks = toks.slice(1);
      hops += 1;
      continue;
    }
    if (head === "timeout") {
      let rest = skipFlags(toks.slice(1), ["-k", "--kill-after", "-s", "--signal"]);
      if (rest.length > 0 && /^\d+(\.\d+)?[smhd]?$/.test(rest[0] as string)) {
        rest = rest.slice(1);
      }
      toks = rest;
      hops += 1;
      continue;
    }
    if (head === "env") {
      let rest = toks.slice(1);
      while (rest.length > 0) {
        const first = rest[0] as string;
        if (ASSIGN_RE.test(first) || first === "-i") {
          rest = rest.slice(1);
        } else if (first === "-u" || first === "--unset") {
          rest = rest.slice(2);
        } else {
          break;
        }
      }
      toks = rest;
      hops += 1;
      continue;
    }
    if (head === "xargs") {
      toks = skipFlags(toks.slice(1), ["-I", "-n", "-P", "-L", "-s", "-a", "-d", "-E"]);
      hops += 1;
      continue;
    }
    if (SHELLS.has(head)) {
      // bash -c 'script': evaluates the inner script recursively.
      for (let j = 1; j < toks.length; j++) {
        const tok = toks[j] as string;
        if (tok === "-c" || tok === "-lc") {
          if (j + 1 < toks.length) {
            return isDangerous(toks[j + 1] as string, depth + hops + 1);
          }
          break;
        }
      }
      return false;
    }
    break;
  }
  if (toks.length === 0) return false;
  return isDangerousHead(path.posix.basename(stripBackticks(toks[0] as string)), toks.slice(1));
}

function isDangerousHead(head: string, args: string[]): boolean {
  if (head === "rm") return dangerousRm(args);
  if (head === "shred") return true;
  if (head.startsWith("mkfs")) return true;
  if (head === "dd") return args.some((a) => a.startsWith("of=/dev/"));
  if (head === "git") return dangerousGit(args);
  if (head === "truncate") return dangerousTruncate(args);
  return false;
}

function dangerousRm(args: string[]): boolean {
  // rm with force, or recursive without interactivity.
  let force = false;
  let recursive = false;
  let interactive = false;
  for (const a of args) {
    if (a === "--force") {
      force = true;
    } else if (a === "--recursive") {
      recursive = true;
    } else if (a.startsWith("--interactive")) {
      interactive = true;
    } else if (a.startsWith("-") && !a.startsWith("--")) {
      const flags = new Set(a.slice(1));
      force = force || flags.has("f");
      recursive = recursive || flags.has("r") || flags.has("R");
      interactive = interactive || flags.has("i") || flags.has("I");
    }
  }
  return force || (recursive && !interactive);
}

function dangerousGit(args: string[]): boolean {
  if (args.length === 0) return false;
  const sub = args[0] as string;
  const rest = args.slice(1);
  if (sub === "reset") return rest.includes("--hard");
  if (sub === "clean") {
    // git clean only acts with -f (or --force), including in a cluster (-fd).
    return rest.some(
      (a) => a === "--force" || (a.startsWith("-") && !a.startsWith("--") && a.slice(1).includes("f")),
    );
  }
  if (sub === "push") return rest.some((a) => a === "--force" || a === "-f");
  // `git checkout -- <path>` discards local modifications to those paths; the
  // prompt (src/prompts/git-safety.ts) promises this needs confirmation just
  // like reset --hard/clean -f, so it must be classified the same way.
  if (sub === "checkout") return rest.includes("--");
  // `stash pop`/`stash clear` mutate or drop stash entries that may belong to
  // another worktree/session sharing the same stash stack (git-safety.ts);
  // applying or clearing the wrong entry silently discards someone else's WIP.
  if (sub === "stash") return rest[0] === "pop" || rest[0] === "clear";
  return false;
}

function dangerousTruncate(args: string[]): boolean {
  if (args.includes("-s0") || args.includes("--size=0")) return true;
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "-s" || args[i] === "--size") && i + 1 < args.length && args[i + 1] === "0") {
      return true;
    }
  }
  return false;
}
