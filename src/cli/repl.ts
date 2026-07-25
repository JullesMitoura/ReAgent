/**
 * Interactive REPL: prompt with live @file completion, persistent history, and
 * Ctrl+C handling (cancels the turn / kills tool processes; the REPL survives).
 *
 * Line editing uses lib/repl-input.ts (raw-mode) rather than node:readline's
 * Tab completer — Cursor's integrated terminal often swallows Tab, which made
 * @attachments look broken. Suggestions appear as you type after `@`.
 *
 * Cooperative cancellation: Ctrl+C during the turn sets the TurnContext cancel
 * flag and kills tool processes; the REPL prints "Turn interrupted." Ctrl+C at
 * the prompt exits with "See you!".
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Agent, TurnCancelled } from "../agent.js";
import { runTurn } from "../agent-render.js";
import { ATTACHMENT_RE, expand } from "../attachments.js";
import { ChangeTracker } from "../changes.js";
import { config } from "../config.js";
import { loadCommands } from "../custom-commands.js";
import { IGNORED_DIRS, PROTECTED_FILES } from "../config.js";
import { realpathSafe } from "../config.js";
import { runSessionEndHooks } from "../hooks/runner.js";
import { setSharedLineReader } from "../lib/interactive-line.js";
import { PromptClosedError, ReplInput } from "../lib/repl-input.js";
import { getLogger } from "../logs.js";
import { killAllToolProcesses } from "../tools/process-registry.js";
import { newTurnContext, runWithTurn } from "../turn-context.js";
import { c, handleCommand } from "./slash-commands.js";
import type { ReplUI } from "./slash-commands.js";

const log = getLogger("reagent.cli");

// Builtin commands offered by the completer. Must track every name handled
// in slash-commands.ts's handleCommand() — a name missing here is invisible
// to Tab-completion even though it works and is documented in /help.
const BUILTIN_COMMANDS = [
  "/help", "/new", "/clear", "/cd", "/sessions", "/resume", "/fork",
  "/search", "/undo", "/init", "/context", "/compact", "/todos",
  "/usage", "/tools", "/doctor", "/mode", "/plan", "/coordinator",
  "/spawn", "/verbosity", "/exit", "/quit",
];

// --- persistent history ------------------------------------------------------

/** Path of the prompt history (~/.reagent/prompt_history). */
export function promptHistoryPath(): string {
  return path.join(os.homedir(), ".reagent", "prompt_history");
}

/**
 * Prompt history: file-backed in ~/.reagent when home is writable; otherwise
 * (OSError) in memory only. Mirrors Python's _prompt_history()
 * (FileHistory OR InMemoryHistory).
 */
export interface PromptHistory {
  /** true = persistent in a file; false = in-memory-only fallback. */
  readonly persistent: boolean;
  readonly path: string | null;
  /** past lines, most recent first (the format readline expects). */
  load(): string[];
  /** appends a submitted line (no-op in the in-memory fallback). */
  append(line: string): void;
}

function encodeLine(line: string): string {
  return line.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

function decodeLine(line: string): string {
  return line.replace(/\\n/g, "\n").replace(/\\\\/g, "\\");
}

/** Builds the history (persistent or fallback), like _prompt_history(). */
export function promptHistory(): PromptHistory {
  const memory: string[] = [];
  let file: string | null = null;
  try {
    const dir = path.join(os.homedir(), ".reagent");
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, "prompt_history");
  } catch {
    file = null; // home not writable: keep history in this session only
  }
  return {
    persistent: file !== null,
    path: file,
    load(): string[] {
      if (file === null) return [...memory].reverse();
      try {
        const text = fs.readFileSync(file, "utf8");
        const lines = text.split("\n").filter((l) => l.length > 0).map(decodeLine);
        return lines.reverse(); // readline expects the most recent first
      } catch {
        return [];
      }
    },
    append(line: string): void {
      memory.push(line);
      if (file === null) return;
      try {
        fs.appendFileSync(file, encodeLine(line) + "\n");
      } catch {
        // disk full / permission: ignore, history in memory only from here on
      }
    },
  };
}

// --- completer for slash commands and @files ---------------------------------

/** Lists directory children to complete @path (dirs first, filtered). */
function attachmentCandidates(prefix: string): string[] {
  let base: string;
  try {
    if (!prefix) {
      base = config.root;
    } else if (path.extname(prefix)) {
      base = path.dirname(resolveInRoot(prefix));
    } else {
      const resolved = resolveInRoot(prefix);
      base = isDir(resolved) ? resolved : path.dirname(resolved);
    }
  } catch {
    base = config.root;
  }
  let children: string[];
  try {
    children = fs.readdirSync(base);
  } catch {
    return [];
  }
  const entries = children
    .map((name) => {
      const full = path.join(base, name);
      return { name, full, dir: isDir(full) };
    })
    .sort((a, b) => {
      if (a.dir !== b.dir) return a.dir ? -1 : 1;
      const na = a.name.toLowerCase();
      const nb = b.name.toLowerCase();
      return na < nb ? -1 : na > nb ? 1 : 0;
    });
  const out: string[] = [];
  for (const child of entries) {
    if (IGNORED_DIRS.has(child.name) || PROTECTED_FILES.has(child.name)) continue;
    let rel = path.relative(config.root, child.full).split(path.sep).join("/");
    if (child.dir) rel += "/";
    if (rel.startsWith(prefix)) out.push("@" + rel);
  }
  return out;
}

function resolveInRoot(p: string): string {
  const abs = path.isAbsolute(p) ? p : path.join(config.root, p);
  const r = realpathSafe(abs);
  if (r !== config.root && !r.startsWith(config.root + path.sep)) {
    throw new Error("outside root");
  }
  return r;
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * readline completer: returns [candidates, replaced fragment]. Completes
 * slash commands (a line starting with /) and @file references.
 */
export function completeLine(line: string): [string[], string] {
  const at = /(?<!\w)@([^\s@]*)$/.exec(line);
  if (at) {
    const prefix = at[1]!;
    const substring = "@" + prefix;
    const hits = attachmentCandidates(prefix);
    return [hits, substring];
  }
  if (/^\/\S*$/.test(line)) {
    const custom = Object.keys(loadCommands()).map((n) => "/" + n);
    const all = [...BUILTIN_COMMANDS, ...custom];
    const hits = all.filter((cmd) => cmd.startsWith(line));
    return [hits.length ? hits : all, line];
  }
  return [[], line];
}

/** Longest shared prefix of `strs` ("" when none / empty). */
export function longestCommonPrefix(strs: string[]): string {
  if (strs.length === 0) return "";
  let prefix = strs[0]!;
  for (let i = 1; i < strs.length; i++) {
    const s = strs[i]!;
    while (!s.startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
      if (!prefix) return "";
    }
  }
  return prefix;
}

// --- prompt session ----------------------------------------------------------

const PROMPT = "\n" + c.cyan("❯ ");

/** Shows the @references that will be expanded into the agent context. */
function printAttachmentSummary(input: string): void {
  const attachments = Array.from(new Set(Array.from(input.matchAll(ATTACHMENT_RE), (match) => match[0])));
  if (attachments.length === 0) return;
  process.stdout.write(c.cyan(`Context attachments: ${attachments.join(", ")}`) + "\n");
}

export interface PromptSessionLike {
  history: PromptHistory;
  completer(line: string): [string[], string];
  /** reads a line; rejects with PromptClosed on Ctrl+C/EOF at the prompt. */
  prompt(): Promise<string>;
  /** registers (or clears) the Ctrl+C callback during a turn. */
  setTurnCancel(onCancel: (() => void) | null): void;
  close(): void;
}

/** Signals prompt exit (Ctrl+C or Ctrl+D), like (KeyboardInterrupt, EOFError). */
export class PromptClosed extends Error {}

/**
 * Builds the prompt session. Uses ReplInput (raw-mode line editor) so @file
 * suggestions appear as you type — node:readline's Tab completer is often
 * swallowed by Cursor's integrated terminal.
 */
export function makePromptSession(): PromptSessionLike {
  const history = promptHistory();
  const input = new ReplInput();
  let turnCancel: (() => void) | null = null;
  let installed = false;

  const ensureInstalled = (): void => {
    if (installed) return;
    installed = true;
    // Permissions / question / trust must share this same reader (see
    // lib/interactive-line.ts). Plain ask — no @ completer — for those prompts.
    setSharedLineReader((prompt) =>
      input.ask(prompt, {
        onCtrlC: () => {
          if (turnCancel) turnCancel();
        },
      }),
    );
  };

  return {
    history,
    completer: completeLine,
    prompt(): Promise<string> {
      ensureInstalled();
      return input
        .ask(PROMPT, {
          completer: completeLine,
          history: history.load(),
          onSubmit: (line) => history.append(line),
          // No onCtrlC: Ctrl+C rejects with PromptClosedError → "See you!".
        })
        .catch((e) => {
          if (e instanceof PromptClosedError) throw new PromptClosed();
          throw e;
        });
    },
    setTurnCancel(onCancel: (() => void) | null): void {
      turnCancel = onCancel;
    },
    close(): void {
      input.close();
      setSharedLineReader(null);
    },
  };
}

// --- cancelable turn execution (shared with -p mode) -------------------------

/**
 * derived `out` that swallows writes after the cancel: the orphan turn (which
 * runs to its own end) does not dirty the terminal after "Turn interrupted.".
 */
export function makeCancelAwareOut(
  base: NodeJS.WriteStream,
  state: { cancelled: boolean },
): NodeJS.WriteStream {
  const wrapper: NodeJS.WriteStream = Object.create(base) as NodeJS.WriteStream;
  (wrapper as { write: unknown }).write = (...args: unknown[]): boolean => {
    if (state.cancelled) {
      const cb = args[args.length - 1];
      if (typeof cb === "function") (cb as () => void)();
      return true;
    }
    return (base.write as (...a: unknown[]) => boolean).apply(base, args);
  };
  return wrapper;
}

/**
 * Runs a turn with render (agent-render) inside a TurnContext, cancelable.
 * `install(onCancel)` wires the cancel trigger (the process SIGINT in -p mode,
 * or the readline SIGINT in the REPL) and returns a disposer. Throws TurnCancelled
 * when cancelled.
 */
export async function runTurnCancelable(
  agent: Agent,
  prompt: string,
  changes: ChangeTracker,
  base: NodeJS.WriteStream,
  install: (onCancel: () => void) => () => void,
): Promise<void> {
  const state = { cancelled: false };
  // Same object referenced by the TurnContext below (like the server's
  // RunningTurn.cancel): setting it here is what actually stops the agent
  // loop, via agent-render's emit throwing TurnCancelled on the next event.
  // Racing runTurn() against `cancelled` alone only stops *awaiting* it; the
  // loop itself would otherwise keep running detached (more LLM/tool calls,
  // its own session.save() racing the next turn's) after "Turn interrupted."
  const cancel = { set: false };
  let reject: (e: Error) => void = () => {};
  const cancelled = new Promise<never>((_, r) => {
    reject = r;
  });
  const dispose = install(() => {
    if (state.cancelled) return;
    state.cancelled = true;
    cancel.set = true;
    killAllToolProcesses(); // bash + exec sessions + background tasks
    reject(new TurnCancelled());
  });
  const out = makeCancelAwareOut(base, state);
  try {
    await runWithTurn(newTurnContext({ changes, cancel, sessionPermissions: agent.session }), () =>
      Promise.race([runTurn(agent, prompt, out, changes), cancelled]),
    );
  } finally {
    dispose();
  }
}

// --- main loop ---------------------------------------------------------------

/** Runs the interactive REPL until the user exits (/exit, exit, Ctrl+C/Ctrl+D). */
export async function runRepl(agent: Agent): Promise<void> {
  const changes = new ChangeTracker();
  const session = makePromptSession();
  const ui: ReplUI = {
    print: (text: string) => process.stdout.write(text + "\n"),
    changes,
    runTurn: (a: Agent, prompt: string) =>
      runTurnCancelable(a, prompt, changes, process.stdout, (onCancel) => {
        session.setTurnCancel(onCancel);
        return () => session.setTurnCancel(null);
      }),
  };

  for (;;) {
    let input: string;
    try {
      input = await session.prompt();
    } catch (e) {
      if (e instanceof PromptClosed) {
        process.stdout.write(c.green("See you!") + "\n");
        break;
      }
      throw e;
    }
    if (!input) continue;

    if (input.startsWith("/") || input === "exit" || input === "sair") {
      const cmd = input.startsWith("/") ? input : "/exit";
      let result: Agent | null;
      try {
        result = await handleCommand(cmd, agent, ui);
      } catch (e) {
        process.stdout.write(
          c.red(`Command error: ${e instanceof Error ? e.message : String(e)}`) + "\n",
        );
        continue;
      }
      if (result === null) {
        process.stdout.write(c.green("See you!") + "\n");
        break;
      }
      agent = result;
      continue;
    }

    try {
      printAttachmentSummary(input);
      await ui.runTurn(agent, expand(input));
    } catch (e) {
      if (e instanceof TurnCancelled) {
        // Ctrl+C during the turn: bash was already killed; the REPL survives.
        process.stdout.write("\n" + c.red("Turn interrupted.") + "\n");
      } else {
        // an API error never takes down the REPL
        log.warning("turn failed: %s", e instanceof Error ? e.message : String(e));
        process.stdout.write(c.red(`LLM call error: ${e instanceof Error ? e.message : String(e)}`) + "\n");
      }
    }
  }
  // A persistent exec_command (PTY) session or an un-backgrounded shell
  // child left running keeps a live handle open; process.on("exit", cleanup)
  // in exec-sessions.ts/process-registry.ts can never fire to catch it,
  // since THAT handle is exactly what stops the event loop from ever going
  // idle enough to reach "exit" in the first place. Without killing them
  // here, "/quit"/Ctrl+D print "See you!" and the loop below ends, but the
  // process itself never actually terminates — the terminal is left in a
  // half-attached state (no prompt, raw keystrokes just echo back) until
  // it's killed externally.
  killAllToolProcesses();
  try {
    runSessionEndHooks();
  } catch {
    // hooks must never block exit
  }
  session.close();
}
