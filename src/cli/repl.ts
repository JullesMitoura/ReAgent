/**
 * Port of the interactive loop in src/main.py (REPL): prompt with node:readline,
 * persistent history, a completer for slash commands and @files, and the
 * handling of Ctrl+C (kills the active bash, the REPL survives).
 *
 * Python's prompt_toolkit has no 1:1 equivalent (section 4.6 of the
 * MIGRATION_SPEC): phase 1 uses node:readline with history + completer. The
 * inline @ highlight (lexer) is cosmetic and not ported here.
 *
 * Cooperative cancellation (Python KeyboardInterrupt -> Node): the Agent only
 * stops when emit raises; since the agent-render render does not raise, we use an
 * `out` that swallows output after the cancel (the orphan turn stays silent) and
 * a race against a cancel signal. Ctrl+C during the turn calls shell.killActive()
 * (unblocks the running bash) and hands control back to the REPL with "Turn
 * interrupted." in red; Ctrl+C at the prompt exits with "See you!".
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import { Agent, TurnCancelled } from "../agent.js";
import { runTurn } from "../agent-render.js";
import { ATTACHMENT_RE, expand } from "../attachments.js";
import { ChangeTracker } from "../changes.js";
import { config } from "../config.js";
import { loadCommands } from "../custom-commands.js";
import { IGNORED_DIRS, PROTECTED_FILES } from "../config.js";
import { realpathSafe } from "../config.js";
import { runSessionEndHooks } from "../hooks/runner.js";
import { getLogger } from "../logs.js";
import { killActive } from "../tools/shell.js";
import { newTurnContext, runWithTurn } from "../turn-context.js";
import { c, handleCommand } from "./slash-commands.js";
import type { ReplUI } from "./slash-commands.js";

const log = getLogger("reagent.cli");

// Builtin commands offered by the completer (the same set as /help).
const BUILTIN_COMMANDS = [
  "/help", "/new", "/clear", "/cd", "/sessions", "/resume", "/fork",
  "/search", "/undo", "/init", "/context", "/compact", "/todos",
  "/usage", "/tools", "/exit", "/quit",
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

// --- prompt session (readline) -----------------------------------------------

const PROMPT = "\n" + c.cyan("❯ ");

/** Shows the @references that will be expanded into the agent context.
 * readline cannot safely color individual spans inside its editable buffer, so
 * acknowledgement is rendered immediately after submission instead. */
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
 * Builds the prompt session (equivalent of _make_prompt_session). The readline
 * is created lazily (construction must not hold stdin in the tests).
 */
export function makePromptSession(): PromptSessionLike {
  const history = promptHistory();
  let rl: readline.Interface | null = null;
  let turnCancel: (() => void) | null = null;
  let pendingReject: ((e: Error) => void) | null = null;

  const onSigint = (): void => {
    // during a turn: delegate to the turn's cancel; at the prompt: end the REPL
    if (turnCancel) {
      turnCancel();
      return;
    }
    const reject = pendingReject;
    pendingReject = null;
    if (reject) reject(new PromptClosed());
  };

  const ensureRl = (): readline.Interface => {
    if (rl) return rl;
    rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: Boolean(process.stdin.isTTY),
      completer: (line: string) => completeLine(line),
      history: history.load(),
      historySize: 1000,
    });
    rl.on("SIGINT", onSigint);
    rl.on("close", () => {
      const reject = pendingReject;
      pendingReject = null;
      if (reject) reject(new PromptClosed());
    });
    return rl;
  };

  return {
    history,
    completer: completeLine,
    prompt(): Promise<string> {
      const iface = ensureRl();
      return new Promise<string>((resolve, reject) => {
        pendingReject = reject;
        iface.question(PROMPT, (answer) => {
          pendingReject = null;
          const trimmed = answer.trim();
          if (trimmed) history.append(trimmed);
          resolve(trimmed);
        });
      });
    },
    setTurnCancel(onCancel: (() => void) | null): void {
      turnCancel = onCancel;
    },
    close(): void {
      if (rl) rl.close();
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
  let reject: (e: Error) => void = () => {};
  const cancelled = new Promise<never>((_, r) => {
    reject = r;
  });
  const dispose = install(() => {
    if (state.cancelled) return;
    state.cancelled = true;
    killActive(); // unblocks the running bash
    reject(new TurnCancelled());
  });
  const out = makeCancelAwareOut(base, state);
  try {
    await runWithTurn(newTurnContext({ changes }), () =>
      Promise.race([runTurn(agent, prompt, out), cancelled]),
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
        process.stdout.write("\nSee you!\n");
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
        process.stdout.write("See you!\n");
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
  try {
    runSessionEndHooks();
  } catch {
    // hooks must never block exit
  }
  session.close();
}
