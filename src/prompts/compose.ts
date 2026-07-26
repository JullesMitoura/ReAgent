/**
 * Cache-aware system prompt composition (Claude Code / Codex pattern).
 *
 * Order: stable core → conditional rules → volatile disk blocks (last).
 * Situational reminders are NOT assembled here; inject via prompts/reminders.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { config } from "../config.js";
import * as projectContext from "../project-context.js";
import { available } from "../sandbox.js";
import { listSkillCatalog } from "../skills/load.js";
import * as userProfile from "../user-profile.js";

import {
  APP_SOURCE_PROTECTED_LINE,
  APP_SOURCE_UNPROTECTED_LINE,
  BEST_PRACTICE_RULES,
  CONTEXT_LABEL,
  EXEC_SESSIONS_RULE,
  GIT_SAFETY,
  PARALLEL_RULE,
  RULES_HEAD,
  RULES_TAIL,
  SANDBOX_APPROVAL_REQUIRED_LINE,
  SANDBOX_AUTO_APPROVE_LINE,
  SANDBOX_HEADER,
  SANDBOX_NETWORK_LINE,
  SANDBOX_OS_LINE,
  SANDBOX_READONLY_LINE,
  SANDBOX_REPEATED_DENIAL_LINE,
  USER_PROFILE_LABEL,
  projectInstructionsLabel,
} from "./core/index.js";
import { DELEGATION_RESTRAINT, WRITING_SUBAGENT_PROMPTS, spawnModePolicy } from "./tools/agent-briefing.js";
import { COORDINATOR_ORCHESTRATION } from "./agents/coordinator.js";
import { modePromptRule } from "../modes.js";

function todayIso(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Real login shell (basename of $SHELL), falling back to a platform default. */
function shellName(): string {
  const shell = process.env["SHELL"];
  if (shell) return path.basename(shell);
  return process.platform === "win32" ? "cmd.exe" : "bash";
}

/** Whether config.root is inside a git working tree. */
function isGitRepo(): boolean {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: config.root,
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

function sandboxRules(): string {
  const lines: string[] = [SANDBOX_HEADER];
  if (available()) {
    lines.push(SANDBOX_OS_LINE);
    if (!config.sandboxNetwork) {
      lines.push(SANDBOX_NETWORK_LINE);
    }
    lines.push(SANDBOX_REPEATED_DENIAL_LINE);
  }
  lines.push(SANDBOX_READONLY_LINE);
  if (config.autoApprove) {
    lines.push(SANDBOX_AUTO_APPROVE_LINE);
  } else {
    lines.push(SANDBOX_APPROVAL_REQUIRED_LINE);
  }
  return lines.join("\n");
}

function rulesBlock(): string {
  return [
    RULES_HEAD,
    config.protectAppSource ? APP_SOURCE_PROTECTED_LINE : APP_SOURCE_UNPROTECTED_LINE,
    config.enableParallel ? PARALLEL_RULE : "",
    config.enableExecSessions ? EXEC_SESSIONS_RULE : "",
    modePromptRule(config.permissionMode),
    config.coordinatorMode ? `\n${COORDINATOR_ORCHESTRATION}\n` : "",
    config.enableSubagent || config.enableParallel
      ? `\n${spawnModePolicy(config.spawnMode)}\n\n${DELEGATION_RESTRAINT}\n`
      : "",
    RULES_TAIL,
    BEST_PRACTICE_RULES,
    config.enableSubagent || config.enableParallel ? `\n${WRITING_SUBAGENT_PROMPTS}` : "",
  ].join("\n");
}

/** Optional capped git status for situational orientation (volatile). */
function gitStatusSnippet(): string {
  try {
    const out = execFileSync("git", ["status", "--porcelain", "-b"], {
      cwd: config.root,
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const trimmed = out.trim();
    if (!trimmed) return "";
    const lines = trimmed.split("\n").slice(0, 40);
    return (
      `\nGit status (capped): this is the state at the start of the conversation, ` +
      `a point-in-time snapshot that will not update as the conversation continues.\n${lines.join("\n")}\n`
    );
  } catch {
    return "";
  }
}

// --- AGENTS.md / CLAUDE.md hierarchy (Claude Code style) ---------------------

const INSTRUCTION_FILE_NAMES = ["AGENTS.md", "CLAUDE.md"] as const;
const MAX_INSTRUCTIONS_CHARS = 40_000;
const MAX_ANCESTOR_LEVELS = 5;

/** First instruction file in a dir (AGENTS.md preferred over CLAUDE.md). */
function readInstructionFile(dir: string): { file: string; text: string } | null {
  for (const name of INSTRUCTION_FILE_NAMES) {
    const f = path.join(dir, name);
    try {
      if (fs.statSync(f).isFile()) {
        return { file: f, text: fs.readFileSync(f, "utf8") };
      }
    } catch {
      // ignore
    }
  }
  return null;
}

/**
 * Instruction blocks in precedence order (outermost first, root last = highest
 * precedence): global ~/.reagent/AGENTS.md, then AGENTS.md/CLAUDE.md in each
 * directory from the outermost ancestor (capped at MAX_ANCESTOR_LEVELS above
 * root, stopping at the home directory or filesystem root) down to root.
 * Exported for tests.
 */
export function projectInstructionBlocks(
  rootDir: string,
  homeDir: string,
): Array<{ file: string; text: string }> {
  const blocks: Array<{ file: string; text: string }> = [];
  const globalHit = readInstructionFile(path.join(homeDir, ".reagent"));
  if (globalHit) blocks.push(globalHit);
  const chain: string[] = [rootDir];
  let dir = rootDir;
  for (let i = 0; i < MAX_ANCESTOR_LEVELS && dir !== homeDir; i++) {
    const parent = path.dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
    chain.push(dir);
  }
  chain.reverse();
  for (const d of chain) {
    const hit = readInstructionFile(d);
    if (hit) blocks.push(hit);
  }
  return blocks;
}

/** Hierarchy blocks rendered with per-file labels and a total size cap. */
function projectInstructionsSection(): string {
  let out = "";
  let used = 0;
  for (const { file, text } of projectInstructionBlocks(config.root, os.homedir())) {
    const remaining = MAX_INSTRUCTIONS_CHARS - used;
    if (remaining <= 0) break;
    let body = text;
    let note = "";
    if (body.length > remaining) {
      body = body.slice(0, remaining);
      note = `\n[Project instructions truncated: total cap of ${MAX_INSTRUCTIONS_CHARS} chars reached]`;
    }
    used += body.length;
    out += `\n${projectInstructionsLabel(file)}\n${body}${note}\n`;
  }
  return out;
}

function skillCatalogBlock(): string {
  const skills = listSkillCatalog();
  if (skills.length === 0) return "";
  const lines = skills.map((s) => `- ${s.name}: ${s.description}`);
  return (
    `\nAvailable skills (load full body with the skill tool when needed):\n` + lines.join("\n") + "\n"
  );
}

/**
 * Builds the system prompt. Stable prefix first; volatile disk content last
 * for provider prefix-cache friendliness.
 */
export function composeSystemPrompt(): string {
  let prompt =
    `You are ReAgent, a coding agent running in the user's terminal.\n` +
    `\n` +
    `Working directory: ${config.root}\n` +
    `Is directory a git repo: ${isGitRepo() ? "Yes" : "No"}\n` +
    `Platform: ${os.type()} ${os.release()} (${os.machine()})\n` +
    `Shell: ${shellName()}\n` +
    `Today's date: ${todayIso()}\n` +
    `\n` +
    `Rules:\n` +
    rulesBlock() +
    `\n` +
    `\n` +
    GIT_SAFETY +
    `\n` +
    `\n` +
    sandboxRules() +
    `\n`;

  const profile = userProfile.load();
  if (profile) {
    prompt += `\n${USER_PROFILE_LABEL}\n${profile}\n`;
  }
  const ctx = projectContext.load();
  if (ctx) {
    prompt += `\n${CONTEXT_LABEL}\n${ctx}\n`;
  }
  prompt += projectInstructionsSection();
  prompt += skillCatalogBlock();
  if (config.situationalGit) {
    prompt += gitStatusSnippet();
  }
  return prompt;
}
