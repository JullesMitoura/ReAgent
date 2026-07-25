// Permissions with persistent rules (port of src/permissions.py, opencode
// style). When approving an action the user can choose "always allow": the
// rule is saved in .reagent/permissions.json and equivalent actions no longer
// prompt.
// - bash: rule by command prefix (e.g. "git status", "ls")
// - write/edit/delete: rule by path glob (e.g. "src/**")
//
// Python -> Node adaptations (section 4.1 of MIGRATION_SPEC):
// - global ask_handler becomes currentTurn()?.permissionHandler (TurnContext);
// - _denial (threading.local) becomes a per-TurnContext slot, with a module
//   fallback outside a turn (CLI single-turn);
// - _ask_lock (threading.Lock) becomes an async mutex (Promise chain) wrapping
//   rule checking + prompting: the "always" of the first request auto-approves
//   the equivalent request that was waiting.

import fs from "node:fs";
import path from "node:path";

import { formatPreviewForTerminal } from "./lib/terminal-diff.js";
import { isDangerousCommand, isSafeCommand } from "./command-safety.js";
import { config } from "./config.js";
import { fnmatch } from "./lib/fnmatch.js";
import { askLine } from "./lib/interactive-line.js";
import { tokenize, UnbalancedQuotesError } from "./lib/shell-tokenizer.js";
import { currentTurn } from "./turn-context.js";
import type { SessionPermissionRules, TurnContext } from "./turn-context.js";
import type { PermissionKind } from "./types.js";

function sessionRules(): SessionPermissionRules | null {
  return currentTurn()?.sessionPermissions?.sessionRules ?? null;
}

/**
 * Saves a rule for the rest of this process session only (not to disk).
 * No-ops (and returns false) when the turn has no SessionPermissionHost —
 * never mutates a throwaway object that would make "session" look saved
 * but never match later.
 */
export function saveSessionRule(kind: string, pattern: string): boolean {
  if (kind === "bash" && BANNED_SUGGESTIONS.has(pattern)) return false;
  const rules = sessionRules();
  if (!rules) return false;
  const list = rules[kind as keyof SessionPermissionRules];
  if (!list) return false;
  if (!list.includes(pattern)) list.push(pattern);
  return true;
}

function matchSessionRule(kind: keyof SessionPermissionRules, predicate: (p: string) => boolean): boolean {
  const rules = sessionRules();
  if (!rules) return false;
  return rules[kind].some(predicate);
}

// Neutral texts for outcomes that are not a user "no".
const CANCELLED_MSG = "(turn interrupted; the action was not executed)";
const TIMEOUT_MSG =
  "(no answer from the user; the action was not executed; ask again later)";

// Denial message of the most recent request, per turn (parallel sub-agents
// do not overwrite each other's message).
const denialByTurn = new WeakMap<TurnContext, string | null>();
let denialFallback: string | null = null;

function setDenial(msg: string | null): void {
  const ctx = currentTurn();
  if (ctx) denialByTurn.set(ctx, msg);
  else denialFallback = msg;
}

function takeDenial(): string | null {
  const ctx = currentTurn();
  if (ctx) {
    const msg = denialByTurn.get(ctx) ?? null;
    denialByTurn.set(ctx, null);
    return msg;
  }
  const msg = denialFallback;
  denialFallback = null;
  return msg;
}

/**
 * Consumes the message of the last denied request; without special state, the
 * default. Tools swap the literal "User denied ..." for
 * denialMessage("User denied ...") so cancellation and timeout do not look
 * like a deliberate denial.
 */
export function denialMessage(defaultMsg: string): string {
  return takeDenial() || defaultMsg;
}

// Commands whose "always allow" includes the subcommand (git status != git push).
const MULTI_WORD = new Set([
  "git", "npm", "pnpm", "yarn", "python", "python3", "pip", "uv",
  "docker", "cargo", "go", "make", "poetry", "bun",
]);

// Prefixes that NEVER become an "always allow" rule: they would auto-approve
// arbitrary execution (shells, interpreters, sudo, rm, whole git, runners).
export const BANNED_SUGGESTIONS: ReadonlySet<string> = new Set([
  "sh", "bash", "zsh", "sh -c", "bash -c", "zsh -c",
  "sh -lc", "bash -lc", "zsh -lc",
  "python", "python3", "python -c", "python3 -c",
  "node", "node -e", "perl", "perl -e", "ruby", "ruby -e",
  "env", "sudo", "rm", "git",
  "npm run", "pnpm run", "yarn run", "xargs",
]);

/** Removes (once per project) banned bash rules saved by old versions. */
export function migrateBannedRules(): void {
  const marker = path.join(config.stateDir, "permissions_migrated");
  if (fs.existsSync(marker)) return;
  if (fs.existsSync(config.permissionsFile)) {
    let rules: unknown;
    try {
      rules = JSON.parse(fs.readFileSync(config.permissionsFile, "utf8"));
    } catch {
      rules = null;
    }
    if (rules !== null && typeof rules === "object" && !Array.isArray(rules)) {
      const dict = rules as Record<string, unknown>;
      const bash = Array.isArray(dict["bash"]) ? (dict["bash"] as string[]) : [];
      const kept = bash.filter((p) => !BANNED_SUGGESTIONS.has(p));
      if (kept.length !== bash.length) {
        dict["bash"] = kept;
        fs.writeFileSync(config.permissionsFile, JSON.stringify(dict, null, 2));
      }
    }
  }
  fs.mkdirSync(config.stateDir, { recursive: true });
  fs.closeSync(fs.openSync(marker, "a"));
}

export interface PermissionRules {
  bash: string[];
  write: string[];
  edit: string[];
  delete: string[];
}

/** Reads permissions.json normalized into the 4 lists (corrupted = empty). */
export function loadRules(): PermissionRules {
  migrateBannedRules();
  let raw: unknown = {};
  if (fs.existsSync(config.permissionsFile)) {
    try {
      raw = JSON.parse(fs.readFileSync(config.permissionsFile, "utf8"));
    } catch {
      raw = {};
    }
  }
  const dict =
    raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const list = (key: string): string[] =>
    Array.isArray(dict[key]) ? (dict[key] as string[]) : [];
  return { bash: list("bash"), write: list("write"), edit: list("edit"), delete: list("delete") };
}

/** Persists a rule (deduplicated); a banned bash prefix is never persisted. */
export function saveRule(kind: string, pattern: string): void {
  // defense in depth
  if (kind === "bash" && BANNED_SUGGESTIONS.has(pattern)) return;
  const rules = loadRules();
  const list = rules[kind as keyof PermissionRules];
  if (!list.includes(pattern)) list.push(pattern);
  fs.mkdirSync(config.stateDir, { recursive: true });
  fs.writeFileSync(config.permissionsFile, JSON.stringify(rules, null, 2));
}

// Characters/sequences that introduce chaining, redirection or substitution
// in the shell. A command with any of these can NEVER be auto-approved by a
// prefix rule.
const SHELL_OPERATORS = [";", "|", "&", ">", "<", "`", "$(", "\n", "\r"] as const;

/**
 * True if cmd contains a control/redirection/substitution operator. Covers
 * ; | & (includes && ||), redirections > <, backtick, $( ) and line breaks.
 * Unbalanced quotes (tokenize fails) also count as an operator.
 */
export function hasShellOperators(cmd: string): boolean {
  for (const op of SHELL_OPERATORS) {
    if (cmd.includes(op)) return true;
  }
  try {
    tokenize(cmd);
  } catch (err) {
    if (err instanceof UnbalancedQuotesError) return true;
    throw err;
  }
  return false;
}

/** Rule suggestion: first token (first two for git/npm/...). */
export function bashRuleSuggestion(command: string): string {
  const trimmed = command.trim();
  const tokens = trimmed.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return trimmed;
  if (MULTI_WORD.has(tokens[0]!) && tokens.length > 1) {
    return `${tokens[0]} ${tokens[1]}`;
  }
  return tokens[0]!;
}

// Serializes permission requests WITHIN one turn: parallel sub-agents share
// the parent's ask-lock (see TurnContext.askLockRoot's doc comment — nested
// contexts are distinct objects with their own changes/toolRoot/bgNotify*,
// but they all carry the SAME askLockRoot reference forward from the
// top-level turn), so this keeps their prompts from overlapping for the same
// user. The lock also wraps rule checking (in the confirm* functions): if the
// first request saves an "always allow", the equivalent request that was
// waiting is auto-approved on wakeup.
//
// Keyed by askLockRoot, NOT a single process-global chain: a server hosting
// several concurrent sessions must not have session B's permission prompt
// wait on session A's already-pending one for up to permissionTimeout
// seconds just because both happened to ask at once.
const askChainByTurn = new WeakMap<object, Promise<void>>();
let askChainFallback: Promise<void> = Promise.resolve();

function withAskLock<T>(fn: () => Promise<T>): Promise<T> {
  const key = currentTurn()?.askLockRoot;
  const chain = key ? (askChainByTurn.get(key) ?? Promise.resolve()) : askChainFallback;
  const result = chain.then(fn);
  const next = result.then(
    () => undefined,
    () => undefined,
  );
  if (key) askChainByTurn.set(key, next);
  else askChainFallback = next;
  return result;
}

// --- interactive terminal prompt --------------------------------------------

function printOut(text: string): void {
  process.stdout.write(text + "\n");
}

function style(code: string, text: string): string {
  return process.stdout.isTTY ? `\u001b[${code}m${text}\u001b[0m` : text;
}

// Equivalent of rich Prompt.ask with choices and default "n": Enter denies.
async function promptChoice(prompt: string, choices: string[]): Promise<string> {
  for (;;) {
    const raw = (await askLine(`${prompt} [${choices.join("/")}] (n): `)).trim().toLowerCase();
    if (raw === "") return "n";
    if (choices.includes(raw)) return raw;
    printOut("Please select one of the available options");
  }
}

export type RiskLevel = "low" | "medium" | "high";

/**
 * Risk tag shown alongside a terminal permission prompt, derived purely from
 * the action's kind (delete/dangerous bash = high, write/edit = medium, a
 * safe-by-default bash prompt = low). No new parameters needed at call sites:
 * `action` already carries the "[dangerous]" prefix confirmBash sets.
 */
export function riskLevel(kind: PermissionKind, action: string): RiskLevel {
  if (kind === "delete") return "high";
  if (kind === "bash" && action.startsWith("[dangerous]")) return "high";
  if (kind === "write" || kind === "edit") return "medium";
  return "low";
}

function riskTag(level: RiskLevel): string {
  const code = level === "high" ? "31" : level === "medium" ? "33" : "2";
  return style(code, `${level} risk`);
}

// --- question flow -----------------------------------------------------------

async function ask(
  action: string,
  preview: string | null,
  alwaysPattern: string,
  kind: PermissionKind,
): Promise<boolean> {
  setDenial(null); // never inherits state from a previous request
  if (config.autoApprove) return true;
  // acceptEdits: auto-approve file mutations; bash still asks
  if (config.permissionMode === "acceptEdits" && (kind === "write" || kind === "edit" || kind === "delete")) {
    return true;
  }
  // Banned suggestion (sudo, bash, python -c, ...): the prompt still shows, but
  // without the "always" option; an "always" coming from the front is treated as "once".
  const banned = kind === "bash" && BANNED_SUGGESTIONS.has(alwaysPattern);
  const handler = currentTurn()?.permissionHandler ?? null;
  if (handler !== null) {
    const answer = await handler(kind, action, preview, banned ? "" : alwaysPattern);
    // States that are not a user "no": deny with their own message.
    if (answer === "cancelled") {
      setDenial(CANCELLED_MSG);
      return false;
    }
    if (answer === "timeout") {
      setDenial(TIMEOUT_MSG);
      return false;
    }
    if (answer === "always" && !banned) saveRule(kind, alwaysPattern);
    if (answer === "session" && !banned) {
      // Without a SessionPermissionHost, "session" cannot persist — treat as once.
      saveSessionRule(kind, alwaysPattern);
    }
    return answer === "once" || answer === "always" || answer === "session";
  }
  if (!process.stdin.isTTY) {
    // non-interactive mode without --yolo: deny instead of blocking waiting for input
    return false;
  }
  // Pause the render loop's spinner first: its setInterval otherwise keeps
  // writing "\r<frame> running..." every 100ms while this prompt is also
  // writing text and reading stdin, visibly corrupting both (see
  // TurnContext.beforePrompt's doc comment).
  currentTurn()?.beforePrompt?.();
  try {
    printOut(`\n${style("1;33", "⚠ Permission")} (${riskTag(riskLevel(kind, action))}): ${action}`);
    if (preview) printOut(formatPreviewForTerminal(preview));
    if (banned) {
      const choice = await promptChoice("[y]es once / [n]o", ["y", "n"]);
      return choice === "y";
    }
    const choice = await promptChoice(
      `[y]es once / [s]ession / [a]lways allow ${style("36", alwaysPattern)} / [n]o`,
      ["y", "s", "a", "n"],
    );
    if (choice === "a") {
      saveRule(kind, alwaysPattern);
      printOut(style("2", `Rule saved permanently: ${kind} → ${alwaysPattern}`));
      return true;
    }
    if (choice === "s") {
      saveSessionRule(kind, alwaysPattern);
      printOut(style("2", `Allowed for this session: ${kind} → ${alwaysPattern}`));
      return true;
    }
    return choice === "y";
  } finally {
    currentTurn()?.afterPrompt?.();
  }
}

/**
 * One-off confirmation requested by a PreToolUse hook ("ask" decision).
 * Never offers a persistent "always" rule: the hook decides per call.
 */
export function confirmHookAsk(toolName: string, reason: string | null): Promise<boolean> {
  return withAskLock(async () => {
    setDenial(null);
    if (config.autoApprove) return true;
    const action = `hook requires confirmation for tool '${toolName}'`;
    const handler = currentTurn()?.permissionHandler ?? null;
    if (handler !== null) {
      // Empty always-pattern: the front hides the "always" option (banned-style).
      const answer = await handler("bash", action, reason, "");
      if (answer === "cancelled") {
        setDenial(CANCELLED_MSG);
        return false;
      }
      if (answer === "timeout") {
        setDenial(TIMEOUT_MSG);
        return false;
      }
      return answer === "once" || answer === "always";
    }
    if (!process.stdin.isTTY) return false;
    currentTurn()?.beforePrompt?.();
    try {
      printOut(`\n${style("1;33", "⚠ Permission")} (${riskTag("medium")}): ${action}`);
      if (reason) printOut(style("2", reason));
      const choice = await promptChoice("[y]es once / [n]o", ["y", "n"]);
      return choice === "y";
    } finally {
      currentTurn()?.afterPrompt?.();
    }
  });
}

/**
 * Confirms the execution of a bash command (prefix rules).
 *
 * `description` is the model's 5-10 word summary of what the command does
 * (bash tool parameter); when present it is shown as the prompt preview so
 * the user understands the intent before approving.
 */
export function confirmBash(command: string, description?: string): Promise<boolean> {
  const cmd = command.trim();
  const preview = description?.trim() ? description.trim() : null;
  return withAskLock(async () => {
    // Dangerous (rm -rf, git reset --hard, ...): never auto-approved by a saved
    // "always allow" rule; goes straight to the prompt. Under AUTO_APPROVE
    // (--yolo), only passes with the explicit ALLOW_DANGEROUS valve; without it,
    // deny instead of approving silently (mirrors Codex's Forbidden).
    if (isDangerousCommand(cmd)) {
      if (config.autoApprove && !config.allowDangerous) {
        printOut(
          `${style("33", "[dangerous]")} auto-approve does not cover ` +
            'dangerous commands; use --allow-dangerous (or "allow_dangerous": true)',
        );
        setDenial(
          "(dangerous command blocked: auto-approve does not cover " +
            "dangerous commands; the user must opt in with --allow-dangerous)",
        );
        return false;
      }
      return ask(`[dangerous] execute command: ${cmd}`, preview, bashRuleSuggestion(cmd), "bash");
    }
    // Known read-only (ls, git status, cat | head, ...): allow without prompt
    // and without consulting rules.
    if (isSafeCommand(cmd)) return true;
    // Composite commands (shell operators) are never auto-approved by a prefix
    // rule: a "git status" rule cannot allow "git status && cat .env". Goes
    // straight to the prompt.
    if (!hasShellOperators(cmd)) {
      const matches = (prefix: string) => cmd === prefix || cmd.startsWith(prefix + " ");
      if (matchSessionRule("bash", matches)) return true;
      for (const prefix of loadRules().bash) {
        if (matches(prefix)) return true;
      }
    }
    return ask(`execute command: ${cmd}`, preview, bashRuleSuggestion(cmd), "bash");
  });
}

/** kind: "write", "edit" or "delete"; relPath relative to the project root. */
export function confirmFile(
  kind: "write" | "edit" | "delete",
  action: string,
  relPath: string,
  preview: string | null = null,
): Promise<boolean> {
  return withAskLock(async () => {
    if (matchSessionRule(kind, (pattern) => fnmatch(relPath, pattern))) return true;
    for (const pattern of loadRules()[kind]) {
      if (fnmatch(relPath, pattern)) return true;
    }
    const parts = relPath.split("/");
    const suggestion = parts.length > 1 ? `${parts[0]}/**` : relPath;
    return ask(action, preview, suggestion, kind);
  });
}
