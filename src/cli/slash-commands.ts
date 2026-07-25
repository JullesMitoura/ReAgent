/**
 * Port of _handle_command (src/main.py:169-290): pure dispatcher for the REPL's
 * slash commands.
 *
 * Python is synchronous (rich is synchronous); here some commands run the agent
 * (/init, /compact, /context refresh, custom commands), asynchronous operations
 * in Node. handleCommand is therefore async and returns Promise<Agent | null>
 * (deviation recorded in the task return). The content contract (texts,
 * built-in > custom precedence, the 16 commands) is preserved.
 *
 * The render surface is abstracted by ReplUI: print (one line), the /undo change
 * tracker (persistent across turns) and runTurn (runs a turn with render +
 * TurnContext). This keeps the dispatcher testable without bringing up the REPL
 * or touching the LLM.
 */

import { Agent } from "../agent.js";
import type { ChangeTracker } from "../changes.js";
import { config, parseVerbosity, VERBOSITY_LEVELS } from "../config.js";
import { expand } from "../attachments.js";
import { expandArguments, loadCommands } from "../custom-commands.js";
import { hooksConfigured } from "../hooks/runner.js";
import { parsePermissionMode, PERMISSION_MODES } from "../modes.js";
import * as projectContext from "../project-context.js";
import { Session } from "../session.js";
import { listSkillCatalog } from "../skills/load.js";
import { allAgents } from "../agents/run.js";
import { activeSchemas } from "../tools/index.js";
import { render as renderTodos } from "../tools/todo.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// --- pure ANSI (no dependency); only colors on a TTY, plain text otherwise ----

function sgr(code: string, text: string): string {
  return process.stdout.isTTY ? `[${code}m${text}[0m` : text;
}

/** Minimal palette mirroring the rich colors used by main.py. */
export const c = {
  dim: (t: string): string => sgr("2", t),
  red: (t: string): string => sgr("31", t),
  green: (t: string): string => sgr("32", t),
  yellow: (t: string): string => sgr("33", t),
  cyan: (t: string): string => sgr("36", t),
  blue: (t: string): string => sgr("94", t), // bright blue: readable on dark terminals
  bold: (t: string): string => sgr("1", t),
};

// --- contract texts (main.py:24-52) ------------------------------------------

export const HELP = `${c.bold("Commands:")}
  /help              this help
  /new               new conversation (the current one is saved)
  /cd <path>         change the agent's working directory
  /sessions          list saved sessions
  /resume <n|id>     resume a session (list number or id)
  /fork              duplicate the current session and switch to the copy
  /search <text>     full-text search across past sessions
  /undo              revert file changes made by the last turn
  /init              analyze the project and generate AGENTS.md
  /context           show the auto-generated project map (/context refresh to rebuild)
  /compact           summarize the history to free up context
  /todos             show the agent's task list
  /usage             tokens consumed in this session
  /tools             available tools
  /doctor            diagnose context, skills, hooks, agents, config
  /mode [name]       default|plan|acceptEdits|bypass|bare (alias: /plan on|off)
  /coordinator [on|off]  toggle coordinator orchestration mode
  /spawn [proactive|explicit]  sub-agent spawn policy (Codex-style)
  /verbosity [level] quiet|normal|verbose|debug (how much execution detail is shown)
  /exit              quit

${c.bold("Attachment shortcuts:")}
  @path              type @ to attach a file (suggestions appear as you type)
  Tab or →           accept the highlighted suggestion
  @src/cli/main.ts   attach a file's content to the prompt
  @src/tools/        attach a directory listing`;

export const INIT_PROMPT =
  "Analyze this project (structure, dependencies, entry points, conventions) and write an " +
  "AGENTS.md file at the project root with: a one-paragraph overview, the directory structure, " +
  "the commands to install/run/test, and the code conventions you observed. Keep it concise " +
  "and factual; it will be loaded as instructions for coding agents working on this project.";

// --- UI surface the dispatcher uses ------------------------------------------

export interface ReplUI {
  /** prints one line (the surface decides the destination and the newline). */
  print(text: string): void;
  /** the /undo tracker, persistent across turns (the REPL keeps it alive). */
  changes: ChangeTracker;
  /** runs a turn with render + TurnContext; the prompt is already final (expanded). */
  runTurn(agent: Agent, prompt: string): Promise<void>;
}

// --- session helpers (shared with main.ts) -----------------------------------

/** epoch (seconds) formatted like Python: %d/%m %H:%M in local time. */
export function formatUpdated(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Sessions table (textual equivalent of the rich Table in main.py:55-65). */
export function sessionsTable(): string {
  const rows = Session.list();
  const lines: string[] = [];
  lines.push(
    c.dim(
      `  ${"#".padStart(2)}  ${"id".padEnd(22)} ${"title".padEnd(30)} ${"msgs".padStart(4)}  updated`,
    ),
  );
  rows.forEach((s, i) => {
    const title = (s.title || "(untitled)").slice(0, 30);
    lines.push(
      `  ${String(i + 1).padStart(2)}  ${c.dim(s.id.padEnd(22))} ${title.padEnd(30)} ` +
        `${String(s.messages).padStart(4)}  ${c.dim(formatUpdated(s.updated_at))}`,
    );
  });
  return lines.join("\n");
}

/** Resolves a session reference: 1-based list number OR exact id. */
export function resolveSession(ref: string): Session | null {
  const sessions = Session.list();
  if (/^\d+$/.test(ref)) {
    const n = Number(ref);
    if (n >= 1 && n <= sessions.length) return Session.load(sessions[n - 1]!.id);
  }
  for (const s of sessions) {
    if (s.id === ref) return Session.load(ref);
  }
  return null;
}

// --- dispatcher ---------------------------------------------------------------

/** Splits the command into name + rest (equivalent to str.split(maxsplit=1)). */
function splitCommand(cmd: string): [string, string] {
  const m = /^(\S+)(?:\s+([\s\S]*))?$/.exec(cmd);
  if (!m) return [cmd, ""];
  return [m[1]!, m[2] ?? ""];
}

/**
 * Runs a slash command. Returns the Agent (possibly swapped by /cd, /resume,
 * /fork, /new) or null to end the REPL (/exit, /quit).
 */
export async function handleCommand(cmd: string, agent: Agent, ui: ReplUI): Promise<Agent | null> {
  const [name, arg] = splitCommand(cmd);

  if (name === "/exit" || name === "/quit") {
    return null;
  }

  if (name === "/help") {
    ui.print(HELP);
    const custom = loadCommands();
    const names = Object.keys(custom).sort();
    if (names.length) {
      ui.print(`${c.bold("Custom commands")} ${c.dim("(.reagent/commands/*.md)")}:`);
      for (const cname of names) {
        const desc = custom[cname]!.description;
        ui.print(`  /${cname}${desc ? `  ${c.dim(desc)}` : ""}`);
      }
    }
    return agent;
  }

  if (name === "/new" || name === "/clear") {
    agent.reset();
    ui.print(c.dim("New conversation started."));
    return agent;
  }

  if (name === "/cd") {
    if (!arg) {
      ui.print(c.dim(`Current directory: ${config.root}`) + "  ?  usage: /cd <path>");
      return agent;
    }
    // save the current conversation in the old project before changing root
    agent.session.save();
    let newRoot: string;
    try {
      newRoot = config.setRoot(arg);
    } catch (e) {
      ui.print(c.red(e instanceof Error ? e.message : String(e)));
      return agent;
    }
    const next = new Agent(); // sandbox, sessions and system prompt of the new dir
    ui.print(
      c.dim(`Working directory: `) + c.cyan(newRoot) + c.dim(` (new conversation started)`),
    );
    for (const warn of config.configErrors) ui.print(c.yellow(warn));
    return next;
  }

  if (name === "/sessions") {
    ui.print(sessionsTable());
    return agent;
  }

  if (name === "/resume") {
    if (!arg) {
      ui.print(sessionsTable());
      ui.print(c.dim("Usage: /resume <number or id>"));
      return agent;
    }
    const session = resolveSession(arg);
    if (session === null) {
      ui.print(c.red("Session not found."));
      return agent;
    }
    ui.print(c.dim(`Session resumed: ${session.title || session.id}`));
    return new Agent(session);
  }

  if (name === "/fork") {
    // ensure the current session is in the database before copying (fork reads from SQLite)
    agent.session.save();
    const forked = Session.fork(agent.session.id);
    ui.print(
      c.dim("Session forked: now on ") +
        c.cyan(forked.id) +
        c.dim(` (${forked.title || "(untitled)"})`),
    );
    return new Agent(forked);
  }

  if (name === "/search") {
    if (!arg) {
      ui.print(c.dim("Usage: /search <text>"));
      return agent;
    }
    const results = Session.search(arg);
    if (results.length === 0) {
      ui.print(c.dim("No sessions match that search."));
    }
    for (const r of results) {
      ui.print(
        `${c.cyan(r.id)}  ${r.title || "(untitled)"}  ${c.dim(formatUpdated(r.updated_at))}\n` +
          `  ${c.dim(r.snippet)}`,
      );
    }
    return agent;
  }

  if (name === "/undo") {
    ui.print(ui.changes.undo());
    return agent;
  }

  if (name === "/init") {
    await ui.runTurn(agent, INIT_PROMPT);
    return agent;
  }

  if (name === "/context") {
    if (arg.trim() === "refresh") {
      projectContext.markStale();
      ui.print(c.dim("regenerating project map..."));
      await projectContext.generate();
    }
    const body = projectContext.load();
    if (body) {
      ui.print(c.dim(".reagent/CONTEXT.md"));
      ui.print(body);
    } else {
      ui.print(
        c.dim("no CONTEXT.md yet (generated on the first turn; /context refresh to force)"),
      );
    }
    return agent;
  }

  if (name === "/compact") {
    ui.print(c.dim("compacting context..."));
    await agent.compact();
    return agent;
  }

  if (name === "/todos") {
    ui.print(c.dim("tasks"));
    ui.print(renderTodos());
    return agent;
  }

  if (name === "/usage") {
    ui.print(usageLine(agent));
    return agent;
  }

  if (name === "/tools") {
    const offered = activeSchemas()
      .map((s) => (s as { function?: { name?: string } }).function?.name)
      .filter((n): n is string => typeof n === "string")
      .sort()
      .join(", ");
    ui.print(c.dim(offered));
    if (!config.enableWebfetch) {
      ui.print(c.dim("webfetch disabled (set AGENT_ENABLE_WEBFETCH=1 to enable)"));
    }
    if (!config.enableSubagent) {
      ui.print(c.dim('explore disabled (set "subagent": true in .reagent/config.json to enable)'));
    }
    return agent;
  }

  if (name === "/plan" || name === "/mode") {
    const argl = arg.trim();
    if (name === "/plan") {
      const low = argl.toLowerCase();
      if (low === "on" || low === "1" || low === "true") config.setPlanMode(true);
      else if (low === "off" || low === "0" || low === "false") config.setPlanMode(false);
      else if (!low) config.setPlanMode(!config.planMode);
      else {
        const m = parsePermissionMode(low);
        if (m) config.setPermissionMode(m);
        else {
          ui.print(c.red(`Unknown mode. Use: ${PERMISSION_MODES.join("|")}`));
          return agent;
        }
      }
    } else {
      if (!argl) {
        ui.print(c.dim(`mode: ${config.permissionMode}`));
        return agent;
      }
      const m = parsePermissionMode(argl);
      if (!m) {
        ui.print(c.red(`Unknown mode. Use: ${PERMISSION_MODES.join("|")}`));
        return agent;
      }
      config.setPermissionMode(m);
    }
    ui.print(c.yellow(`mode: ${config.permissionMode}`));
    return agent;
  }

  if (name === "/coordinator") {
    const low = arg.trim().toLowerCase();
    if (low === "on" || low === "1" || low === "true") config.setCoordinatorMode(true);
    else if (low === "off" || low === "0" || low === "false") config.setCoordinatorMode(false);
    else config.setCoordinatorMode(!config.coordinatorMode);
    ui.print(
      config.coordinatorMode
        ? c.yellow("coordinator mode ON")
        : c.dim("coordinator mode OFF"),
    );
    return agent;
  }

  if (name === "/spawn") {
    const low = arg.trim().toLowerCase();
    if (low === "explicit" || low === "proactive") {
      config.setSpawnMode(low);
    } else if (low === "" || low === "toggle") {
      config.setSpawnMode(config.spawnMode === "proactive" ? "explicit" : "proactive");
    } else {
      ui.print(c.dim("usage: /spawn [proactive|explicit]"));
      return agent;
    }
    ui.print(c.yellow(`spawn mode: ${config.spawnMode}`));
    return agent;
  }

  if (name === "/verbosity") {
    const argl = arg.trim().toLowerCase();
    if (!argl) {
      ui.print(c.dim(`verbosity: ${config.verbosity} (levels: ${VERBOSITY_LEVELS.join("|")})`));
      return agent;
    }
    const v = parseVerbosity(argl);
    if (!v) {
      ui.print(c.red(`Unknown verbosity. Use: ${VERBOSITY_LEVELS.join("|")}`));
      return agent;
    }
    config.setVerbosity(v);
    ui.print(c.yellow(`verbosity: ${config.verbosity}`));
    return agent;
  }

  if (name === "/doctor") {
    ui.print(c.bold("ReAgent doctor"));
    ui.print(`  root: ${c.cyan(config.root)}`);
    ui.print(`  model: ${c.cyan(config.azureOpenAILLM)}`);
    ui.print(`  mode: ${config.permissionMode}  coordinator: ${config.coordinatorMode}  spawn: ${config.spawnMode}`);
    ui.print(`  subagent: ${config.enableSubagent}  parallel: ${config.enableParallel}`);
    const ctxPath = path.join(config.stateDir, "CONTEXT.md");
    ui.print(`  CONTEXT.md: ${fs.existsSync(ctxPath) ? "present" : "missing"}`);
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      const p = path.join(config.root, name);
      ui.print(`  ${name}: ${fs.existsSync(p) ? "present" : "missing"}`);
    }
    const profile = config.userProfileFile;
    ui.print(`  USER.md: ${fs.existsSync(profile) ? profile : "missing"}`);
    const skills = listSkillCatalog();
    ui.print(
      `  skills: ${skills.length ? skills.map((s) => s.name).join(", ") : "(none)"}`,
    );
    ui.print(`  hooks: ${hooksConfigured() ? ".reagent/hooks.json present" : "(none)"}`);
    const agents = allAgents();
    ui.print(
      `  agents: ${agents.map((a) => `${a.agentType}(${a.source})`).join(", ")}`,
    );
    const userSkillsDir = path.join(os.homedir(), ".reagent", "skills");
    ui.print(`  user skills dir: ${userSkillsDir}`);
    if (config.configErrors.length) {
      ui.print(c.yellow("  config warnings:"));
      for (const w of config.configErrors) ui.print(c.yellow(`    ${w}`));
    } else {
      ui.print(c.dim("  config: ok"));
    }
    return agent;
  }

  // fallback: custom commands (.reagent/commands/*.md); built-ins win
  const custom = loadCommands()[name.slice(1)];
  if (custom !== undefined) {
    const prompt = expandArguments(custom.body, arg);
    await ui.runTurn(agent, expand(prompt));
    return agent;
  }
  ui.print(c.red(`Unknown command: ${name}`) + " (try /help)");
  return agent;
}

/** Single metrics line for /usage (main.py:256-273). */
function usageLine(agent: Agent): string {
  const u = agent.session.usage;
  const last = u.last_prompt_tokens ?? 0;
  const window = config.contextWindowTokens;
  const n = (x: number): string => x.toLocaleString("en-US");
  let ctx = `current context: ${c.cyan(n(last))} tokens`;
  if (window > 0) {
    const pct = Math.round((100 * last) / window);
    ctx +=
      ` (${c.cyan(`${pct}%`)} of ${Math.trunc(window / 1000)}k window, ` +
      `compacts at ${Math.trunc(config.compactThreshold / 1000)}k)`;
  }
  const dot = "\u00b7";
  let line =
    `prompt: ${c.cyan(n(u.prompt_tokens ?? 0))} tokens  ${dot}  ` +
    `output: ${c.cyan(n(u.completion_tokens ?? 0))} tokens  ${dot}  ` +
    ctx;
  const cached = u.cached_prompt_tokens ?? 0;
  const promptTotal = u.prompt_tokens ?? 0;
  if (cached) {
    const pct = promptTotal ? Math.round((100 * cached) / promptTotal) : 0;
    line += `  ${dot}  cached: ${c.cyan(n(cached))} tokens (${pct}% of prompt)`;
  }
  return line;
}
