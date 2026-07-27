/**
 * Lifecycle hooks, configured via .reagent/hooks.json.
 *
 * Supported events:
 *   PreToolUse          — before a tool runs; can deny/ask (matcher = tool name)
 *   PostToolUse         — after a successful tool run (matcher = tool name)
 *   PostToolUseFailure  — after a tool run fails (matcher = tool name)
 *   Stop                — when the main agent produces its final answer; can block
 *   PreCompact          — before history compaction
 *   UserPromptSubmit    — when the user submits a prompt; can inject context
 *   SessionStart        — session begins ("startup" | "resume" | "compact")
 *   SessionEnd          — session ends
 *   SubagentStart       — before a subagent starts
 *   SubagentStop        — after a subagent finishes its report
 *
 * File format (both shapes are accepted, per event, and may be mixed):
 *
 *   {
 *     "hooks": {
 *       // flat (legacy) — runs on every call of the event
 *       "PreToolUse": [{ "type": "command", "command": "...", "timeout": 10000 }],
 *       // grouped with matcher — matcher applies to the tool name
 *       // on PreToolUse / PostToolUse / PostToolUseFailure and is ignored elsewhere.
 *       // Matching is case-insensitive: "*" / absent = all tools; a plain string
 *       // is an exact match; a string with regex metachars ("bash|edit_file",
 *       // "write_.*") is an anchored regex.
 *       "PostToolUse": [
 *         { "matcher": "bash|edit_file", "hooks": [{ "type": "command", "command": "..." }] }
 *       ]
 *     }
 *   }
 *
 * Command hooks receive a JSON payload on stdin ({event, tool?, arguments?, ...})
 * and REAGENT_HOOK_EVENT in the environment. Exit code semantics:
 *   - PreToolUse: non-zero exit denies the call (stderr/stdout used as reason).
 *   - Other events: exit code is ignored (best-effort).
 *
 * If stdout is parseable JSON, it is interpreted per event:
 *   - PreToolUse:  {"decision": "allow"|"deny"|"ask", "reason": "...",
 *                   "additionalContext": "..."}
 *   - PostToolUse / PostToolUseFailure / UserPromptSubmit / SessionStart:
 *                  {"additionalContext": "..."} — injected back to the model
 *   - Stop:        {"decision": "block", "reason": "..."} — the caller may
 *                  continue the loop with `reason` as feedback
 * Non-JSON stdout is ignored (except as a deny reason on failing PreToolUse).
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { config } from "../config.js";
import { scrubbedEnv } from "../lib/env-scrub.js";
import { getLogger } from "../logs.js";
import { isProjectTrusted } from "../trust.js";

const log = getLogger("hooks");

// Projects whose untrusted hooks.json was already logged once (avoids a
// warning spam on every single PreToolUse/PostToolUse call).
const warnedUntrustedRoots = new Set<string>();

export type HookEvent =
  | "PreToolUse"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "Stop"
  | "PreCompact"
  | "UserPromptSubmit"
  | "SessionStart"
  | "SessionEnd"
  | "SubagentStart"
  | "SubagentStop";

export interface HookCommand {
  type: "command";
  command: string;
  /** Timeout ms (default 10000). */
  timeout?: number;
}

/** Grouped entry: matcher + nested hooks. */
export interface HookMatcherGroup {
  /** Tool-name matcher: exact, regex (when metachars present), or "*" / absent = all. */
  matcher?: string;
  hooks: HookCommand[];
}

export type HookEntry = HookCommand | HookMatcherGroup;

export interface HooksFile {
  hooks?: Partial<Record<HookEvent, HookEntry[]>>;
}

export type PreToolDecision = "allow" | "deny" | "ask";

export interface PreToolResult {
  decision: PreToolDecision;
  message?: string;
  /** Extra context from allow decisions, to inject into the model. */
  additionalContext?: string;
}

export interface PostToolResult {
  additionalContext?: string;
}

export interface StopHookResult {
  block: boolean;
  reason?: string;
}

export interface PromptHookResult {
  additionalContext?: string;
}

function loadHooksFile(): HooksFile {
  const file = path.join(config.stateDir, "hooks.json");
  if (!fs.existsSync(file)) return {};
  // Security gate: an untrusted project's hooks.json must not silently run
  // shell commands (SessionStart fires the instant `reagent` is pointed at a
  // directory; PreToolUse fires before every tool call). Same simple posture
  // as a missing hooks.json: hooks just no-op until the project is trusted.
  if (!isProjectTrusted(config.root)) {
    if (!warnedUntrustedRoots.has(config.root)) {
      warnedUntrustedRoots.add(config.root);
      log.warning(
        "'.reagent/hooks.json' found in an untrusted project (%s); hooks will not run " +
          "until this project is trusted",
        config.root,
      );
    }
    return {};
  }
  try {
    const raw = fs.readFileSync(file, "utf8");
    return JSON.parse(raw) as HooksFile;
  } catch {
    return {};
  }
}

const REGEX_METACHARS = /[|\\^$.*+?()[\]{}]/;

/** Case-insensitive tool-name matcher (exact, regex on metachars, "*" = all). */
function matcherMatches(matcher: string | undefined, toolName: string | undefined): boolean {
  if (!matcher || matcher === "*") return true;
  if (toolName === undefined) return true; // non-tool events ignore matchers
  if (REGEX_METACHARS.test(matcher)) {
    try {
      return new RegExp(`^(?:${matcher})$`, "i").test(toolName);
    } catch {
      // invalid regex: fall through to exact comparison
    }
  }
  return matcher.toLowerCase() === toolName.toLowerCase();
}

/** Flattens flat + grouped entries for an event, applying matchers. */
function collectHooks(event: HookEvent, toolName?: string): HookCommand[] {
  const entries = loadHooksFile().hooks?.[event] ?? [];
  const out: HookCommand[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    if ("command" in entry) {
      if (entry.type === "command") out.push(entry);
      continue;
    }
    if (!Array.isArray(entry.hooks)) continue;
    if (!matcherMatches(entry.matcher, toolName)) continue;
    for (const hook of entry.hooks) {
      if (hook && typeof hook === "object" && hook.type === "command") out.push(hook);
    }
  }
  return out;
}

function runCommand(
  hook: HookCommand,
  payload: Record<string, unknown>,
): { ok: boolean; stdout: string; stderr: string; code: number | null } {
  const timeout = hook.timeout ?? 10_000;
  try {
    const result = spawnSync(hook.command, {
      cwd: config.root,
      encoding: "utf8",
      timeout,
      shell: true,
      input: JSON.stringify(payload),
      env: { ...scrubbedEnv(), REAGENT_HOOK_EVENT: String(payload.event ?? "") },
    });
    return {
      ok: (result.status ?? 1) === 0,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      code: result.status,
    };
  } catch (e) {
    log.warning("hook command failed: %s", String(e));
    return { ok: false, stdout: "", stderr: String(e), code: null };
  }
}

/** Parses hook stdout as a JSON object; returns null for anything else. */
function parseHookJson(stdout: string): Record<string, unknown> | null {
  const text = stdout.trim();
  if (!text.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // not JSON
  }
  return null;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function joinContext(parts: string[]): string | undefined {
  const kept = parts.filter(Boolean);
  return kept.length ? kept.join("\n") : undefined;
}

/**
 * PreToolUse: a failing command (exit != 0) denies the call. A successful
 * command may emit JSON: {"decision":"deny"|"ask"|"allow", "reason", "additionalContext"}.
 */
export function runPreToolUse(toolName: string, argsJson: string): PreToolResult {
  const hooks = collectHooks("PreToolUse", toolName);
  const contexts: string[] = [];
  for (const hook of hooks) {
    const r = runCommand(hook, { event: "PreToolUse", tool: toolName, arguments: argsJson });
    if (!r.ok) {
      const msg = (r.stderr || r.stdout || `hook exited ${r.code}`).trim().slice(0, 500);
      return { decision: "deny", message: msg || "PreToolUse hook denied this call" };
    }
    const json = parseHookJson(r.stdout);
    if (!json) continue;
    const decision = str(json.decision);
    const reason = str(json.reason);
    if (decision === "deny") {
      return { decision: "deny", message: reason || "PreToolUse hook denied this call" };
    }
    if (decision === "ask") {
      return {
        decision: "ask",
        message: reason || "PreToolUse hook requires confirmation",
        additionalContext: joinContext(contexts),
      };
    }
    const extra = str(json.additionalContext);
    if (extra) contexts.push(extra);
  }
  return { decision: "allow", additionalContext: joinContext(contexts) };
}

/** PostToolUse: best-effort; JSON stdout may carry additionalContext. */
export function runPostToolUse(
  toolName: string,
  argsJson: string,
  result: string,
): PostToolResult {
  const hooks = collectHooks("PostToolUse", toolName);
  const contexts: string[] = [];
  for (const hook of hooks) {
    const r = runCommand(hook, {
      event: "PostToolUse",
      tool: toolName,
      arguments: argsJson,
      result: result.slice(0, 4000),
    });
    const extra = str(parseHookJson(r.stdout)?.additionalContext);
    if (extra) contexts.push(extra);
  }
  return { additionalContext: joinContext(contexts) };
}

/** PostToolUseFailure: runs after a tool call errored; may add context. */
export function runPostToolUseFailureHooks(
  toolName: string,
  argsJson: string,
  error: string,
): PostToolResult {
  const hooks = collectHooks("PostToolUseFailure", toolName);
  const contexts: string[] = [];
  for (const hook of hooks) {
    const r = runCommand(hook, {
      event: "PostToolUseFailure",
      tool: toolName,
      arguments: argsJson,
      error: error.slice(0, 4000),
    });
    const extra = str(parseHookJson(r.stdout)?.additionalContext);
    if (extra) contexts.push(extra);
  }
  return { additionalContext: joinContext(contexts) };
}

/**
 * Stop: JSON stdout {"decision":"block","reason":"..."} asks the caller to
 * continue the loop, feeding `reason` back to the model. First block wins.
 */
export function runStopHooks(finalContent: string): StopHookResult {
  const hooks = collectHooks("Stop");
  for (const hook of hooks) {
    const r = runCommand(hook, { event: "Stop", content: finalContent.slice(0, 4000) });
    const json = parseHookJson(r.stdout);
    if (json && str(json.decision) === "block") {
      return { block: true, reason: str(json.reason) };
    }
  }
  return { block: false };
}

export function runPreCompactHooks(): void {
  for (const hook of collectHooks("PreCompact")) {
    runCommand(hook, { event: "PreCompact" });
  }
}

/** UserPromptSubmit: JSON stdout may carry additionalContext for the model. */
export function runUserPromptSubmitHooks(prompt: string): PromptHookResult {
  const contexts: string[] = [];
  for (const hook of collectHooks("UserPromptSubmit")) {
    const r = runCommand(hook, { event: "UserPromptSubmit", prompt: prompt.slice(0, 8000) });
    const extra = str(parseHookJson(r.stdout)?.additionalContext);
    if (extra) contexts.push(extra);
  }
  return { additionalContext: joinContext(contexts) };
}

export type SessionStartSource = "startup" | "resume" | "compact";

/** SessionStart: JSON stdout may carry additionalContext for the model. */
export function runSessionStartHooks(source: SessionStartSource): PromptHookResult {
  const contexts: string[] = [];
  for (const hook of collectHooks("SessionStart")) {
    const r = runCommand(hook, { event: "SessionStart", source });
    const extra = str(parseHookJson(r.stdout)?.additionalContext);
    if (extra) contexts.push(extra);
  }
  return { additionalContext: joinContext(contexts) };
}

export function runSessionEndHooks(): void {
  for (const hook of collectHooks("SessionEnd")) {
    runCommand(hook, { event: "SessionEnd" });
  }
}

/** SubagentStart: fired right before a subagent begins running. */
export function runSubagentStartHooks(agentType: string, prompt: string): void {
  for (const hook of collectHooks("SubagentStart")) {
    runCommand(hook, { event: "SubagentStart", agentType, prompt: prompt.slice(0, 8000) });
  }
}

/** SubagentStop: fired after a subagent produced its report. */
export function runSubagentStopHooks(agentType: string, report: string): void {
  for (const hook of collectHooks("SubagentStop")) {
    runCommand(hook, { event: "SubagentStop", agentType, report: report.slice(0, 8000) });
  }
}

/** Whether any hooks are configured (for /doctor). */
export function hooksConfigured(): boolean {
  const h = loadHooksFile().hooks;
  if (!h) return false;
  return Object.values(h).some((list) => Array.isArray(list) && list.length > 0);
}
