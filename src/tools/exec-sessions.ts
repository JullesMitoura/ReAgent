/**
 * Port of src/tools/exec_sessions.py: persistent shell sessions over PTY
 * (Codex unified exec), using node-pty instead of the pty module.
 *
 * exec_command runs a command in a PTY: if it finishes within yield_time_ms
 * the result comes back directly (no session); if it stays alive, it becomes a
 * numbered session that the model polls (exec_command with session_id) or feeds
 * (write_stdin). Meant for long processes: dev server, REPL, watch.
 *
 * Python -> Node adaptations (section 4.2 of MIGRATION_SPEC):
 * - the reader thread becomes node-pty's onData (already-decoded strings, with
 *   the UTF-8 carry handled by node-pty itself);
 * - proc.poll() becomes the exited flag set by onExit; node-pty only emits
 *   exit after draining the socket, so exited implies the reader drained;
 * - atexit becomes process.on('exit') + SIGTERM/SIGINT handlers;
 * - node-pty is a native dependency: an import failure turns off the gate with
 *   the same disabled message.
 */

import os from "node:os";

import { config } from "../config.js";
import { scrubbedEnv } from "../lib/env-scrub.js";
import { capHeadTail, HeadTailBuffer } from "../lib/head-tail-buffer.js";
import { killProcessTree } from "../lib/proc-kill.js";
import * as permissions from "../permissions.js";
import { shellArgv } from "../sandbox.js";

// Cap of the per-session buffer (memory) and of the increment returned by poll.
export const BUFFER_CAP = 1_000_000;
export const POLL_CAP = 30_000;

// Wait window accepted per call (ms).
export const MIN_YIELD_MS = 250;
export const MAX_YIELD_MS = 60_000;

const DISABLED_MSG = "Error: exec sessions are disabled on this platform/config";

// Minimal node-pty surface used here, declared locally so the build does not
// need node-pty's types (it is an optional native dependency: on a platform or
// build without the native binary the runtime import fails and the gate responds
// with the disabled message).
interface IPty {
  readonly pid: number;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  kill(signal?: string): void;
}
interface PtyModule {
  spawn(
    file: string,
    args: string[],
    options: { name?: string; cwd?: string; env?: { [key: string]: string } },
  ): IPty;
}
let ptyModule: PtyModule | null | undefined;

async function importPty(): Promise<PtyModule> {
  return (await import("node-pty")) as unknown as PtyModule;
}

async function loadPty(): Promise<PtyModule | null> {
  if (ptyModule === undefined) {
    try {
      ptyModule = await importPty();
    } catch {
      ptyModule = null;
    }
  }
  return ptyModule;
}

/** Converts the requested yield to seconds, within [250ms, 60s]. */
function clampYieldS(yieldTimeMs: unknown): number {
  const n = Number(yieldTimeMs);
  const ms = Number.isFinite(n) ? Math.trunc(n) : MIN_YIELD_MS;
  return Math.min(Math.max(ms, MIN_YIELD_MS), MAX_YIELD_MS) / 1000;
}

// Reverse map number -> signal name (Python's signal.Signals(sig).name).
const SIGNAL_NAMES = new Map<number, string>(
  Object.entries(os.constants.signals).map(([name, num]) => [num, name]),
);

/** Formats the returncode; negative becomes 128+signal (mirrors Python's shell/exec). */
function exitCodeStr(code: number | null): string {
  if (typeof code === "number" && code < 0) {
    const sig = -code;
    const name = SIGNAL_NAMES.get(sig) ?? `signal ${sig}`;
    return `${128 + sig} (${name})`;
  }
  return String(code);
}

/** Live session: process in the PTY + incremental buffer (onData does the reading). */
class ExecSession {
  id = 0; // set when registering in the store
  readonly command: string;
  readonly proc: IPty;
  readonly startedAt: number; // epoch em segundos
  readonly buffer = new HeadTailBuffer(BUFFER_CAP);
  exited = false;
  /** Popen.returncode convention: >=0 normal exit, -N killed by signal N */
  returncode: number | null = null;
  private exitWaiters: (() => void)[] = [];

  constructor(command: string, proc: IPty) {
    this.command = command;
    this.proc = proc;
    this.startedAt = Date.now() / 1000; // epoch in seconds
    proc.onData((chunk) => {
      this.buffer.append(chunk);
    });
    proc.onExit(({ exitCode, signal }) => {
      // node-pty only emits exit after the socket EOF: output already drained
      this.returncode = signal ? -signal : exitCode;
      this.exited = true;
      for (const wake of this.exitWaiters.splice(0)) wake();
    });
  }

  /** Waits up to ms (or the process death), whichever comes first. */
  private waitExitOr(ms: number): Promise<void> {
    if (this.exited) return Promise.resolve();
    return new Promise((resolve) => {
      const waiter = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        const i = this.exitWaiters.indexOf(waiter);
        if (i >= 0) this.exitWaiters.splice(i, 1);
        resolve();
      }, ms);
      this.exitWaiters.push(waiter);
    });
  }

  /** Waits up to waitS (or the process death) and returns the increment. */
  async waitOutput(waitS: number): Promise<[string, boolean, number | null]> {
    const deadline = Date.now() + waitS * 1000;
    while (!this.exited) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await this.waitExitOr(remaining);
    }
    const out = this.buffer.take();
    return [capHeadTail(out, POLL_CAP), this.exited, this.returncode];
  }

  /** Kills the whole process group (grandchildren included). Idempotent. */
  kill(): void {
    killProcessTree(this.proc.pid, "SIGKILL");
  }
}

// Global session store: sequential ids starting at 1.
const sessions = new Map<number, ExecSession>();
let nextId = 1;

function register(sess: ExecSession): number {
  const sid = nextId;
  nextId += 1;
  sess.id = sid;
  sessions.set(sid, sess);
  return sid;
}

function aliveSessions(): ExecSession[] {
  return [...sessions.values()].filter((s) => !s.exited);
}

function short(command: string, limit = 40): string {
  return command.length <= limit ? command : command.slice(0, limit - 3) + "...";
}

function liveListing(): string {
  const alive = aliveSessions();
  if (alive.length === 0) return "none";
  return alive.map((s) => `${s.id} (${short(s.command)})`).join(", ");
}

function unknownSessionMsg(sessionId: number): string {
  return `Error: no exec session with id ${sessionId}. Live sessions: ${liveListing()}`;
}

function withExitNote(
  out: string,
  sessionId: number,
  code: number | null,
  wallS: number | null = null,
): string {
  const detail = wallS !== null ? `; wall time ${wallS.toFixed(1)} seconds` : "";
  const note = `[session ${sessionId} terminated with exit code ${exitCodeStr(code)}${detail}]`;
  return out ? `${out}\n${note}` : note;
}

/**
 * Starts the command in a PTY (own process group, env without secrets).
 *
 * Uses the same shell resolution as the bash tool (sandbox.ts's shellArgv):
 * bash on POSIX, Git for Windows' bash.exe on win32. Previously hardcoded
 * "/bin/sh", which does not exist on Windows and diverged from the plain
 * bash tool's own shell choice on POSIX too.
 */
function spawnSession(pty: PtyModule, command: string): ExecSession {
  const [shellPath, ...shellArgs] = shellArgv(command);
  const proc = pty.spawn(shellPath!, shellArgs, {
    name: "xterm",
    cwd: config.root,
    env: scrubbedEnv() as { [key: string]: string },
  });
  return new ExecSession(command, proc);
}

/** Poll an existing session: no new permission, just the new output. */
async function pollSession(sessionId: number, waitS: number): Promise<string> {
  const sess = sessions.get(sessionId);
  if (sess === undefined) return unknownSessionMsg(sessionId);
  const start = Date.now();
  const [out, exited, code] = await sess.waitOutput(waitS);
  if (exited) {
    sessions.delete(sessionId);
    return withExitNote(out, sessionId, code, (Date.now() - start) / 1000);
  }
  if (out) return out;
  return `(no new output; session ${sessionId} still running)`;
}

export async function execCommand(
  command: string,
  yieldTimeMs: number = 10_000,
  sessionId: number | null = null,
): Promise<string> {
  if (!config.enableExecSessions) return DISABLED_MSG;
  const waitS = clampYieldS(yieldTimeMs);
  if (sessionId !== null && sessionId !== undefined) {
    // permission was granted when the session was created; here it is just a poll
    return pollSession(Math.trunc(Number(sessionId)), waitS);
  }

  // No session_id: this call must start a NEW session, which requires a
  // command. Validate before it reaches confirmBash (which does
  // command.trim() and would otherwise crash with a raw TypeError on
  // undefined/non-string input).
  if (typeof command !== "string" || !command.trim()) {
    return (
      "Error: 'command' is required to start a new exec session " +
      "(pass session_id instead to continue an existing one)"
    );
  }

  const pty = await loadPty();
  if (pty === null) return DISABLED_MSG;

  // live session limit checked before opening a process (fail fast)
  const alive = aliveSessions();
  if (alive.length >= config.execSessionMax) {
    return (
      `Error: too many live exec sessions (${alive.length}/${config.execSessionMax}). ` +
      "Close one first (write_stdin with a quit/exit sequence) or wait for it to finish. " +
      `Live sessions: ${liveListing()}`
    );
  }

  if (!(await permissions.confirmBash(command))) {
    // cancel/timeout swap the "User denied" for a neutral message
    return permissions.denialMessage("User denied command execution.");
  }

  let sess: ExecSession;
  try {
    sess = spawnSession(pty, command);
  } catch (e) {
    return `Error: could not start command: ${e instanceof Error ? e.message : String(e)}`;
  }

  const start = Date.now();
  const [out, exited, code] = await sess.waitOutput(waitS);
  if (exited) {
    // finished within the window: direct result, no session created
    const wall = (Date.now() - start) / 1000;
    const header = `Exit code: ${exitCodeStr(code)}\nWall time: ${wall.toFixed(1)} seconds`;
    if (out) return `${header}\nOutput:\n${out}`;
    return header;
  }

  const sid = register(sess);
  const head = `[session ${sid} started; process still running]`;
  const hint =
    `(use write_stdin or exec_command with session_id=${sid} to interact; ` +
    "the process keeps running)";
  if (out) return `${head}\n${out}\n${hint}`;
  return `${head}\n${hint}`;
}

export async function writeStdin(
  sessionId: number,
  chars: string,
  yieldTimeMs: number = 3000,
): Promise<string> {
  if (!config.enableExecSessions) return DISABLED_MSG;
  const waitS = clampYieldS(yieldTimeMs);
  const sess = sessions.get(sessionId);
  if (sess === undefined) return unknownSessionMsg(sessionId);
  if (sess.exited) {
    // dead session: drain what remained, remove from the store and explain
    const [out] = await sess.waitOutput(0);
    sessions.delete(sessionId);
    const msg =
      `Error: session ${sessionId} has already exited (exit code ${sess.returncode}). ` +
      `Live sessions: ${liveListing()}`;
    return out ? `${msg}\n${out}` : msg;
  }
  if (chars) {
    // no automatic \n: the model sends "\n" when it wants Enter
    try {
      sess.proc.write(chars);
    } catch (e) {
      return `Error: could not write to session ${sessionId}: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  const start = Date.now();
  const [out, exited, code] = await sess.waitOutput(waitS);
  if (exited) {
    sessions.delete(sessionId);
    return withExitNote(out, sessionId, code, (Date.now() - start) / 1000);
  }
  if (out) return out;
  return `(no new output; session ${sessionId} still running)`;
}

/** Lists the sessions in the store (debug; not offered as a tool for now). */
export function listSessions(): string {
  if (sessions.size === 0) return "no sessions";
  const now = Date.now() / 1000;
  const lines: string[] = [];
  for (const s of sessions.values()) {
    const status = s.exited ? `exited (${s.returncode})` : "running";
    lines.push(`[${s.id}] ${status} age=${Math.trunc(now - s.startedAt)}s cmd=${short(s.command, 60)}`);
  }
  return lines.join("\n");
}

/** Kills all sessions (SIGKILL on the group). Idempotent. */
export function cleanup(): void {
  const items = [...sessions.values()];
  sessions.clear();
  for (const sess of items) sess.kill();
}

// Never leak dev servers on process exit (Python's atexit). On signals, only
// force-terminate the process when nobody else claimed ownership of the exit
// path: a REPL registers its OWN Ctrl+C handling via readline's interface-
// level 'SIGINT' event (rl.on("SIGINT", ...)), not process.on("SIGINT", ...),
// so `process.listenerCount(sig)` never actually reflects that — this module
// loads (and registers its own process-level listener) well before the REPL
// even starts, so the count was always exactly 1 regardless of context,
// meaning a stray SIGINT (e.g. one delivered while readline briefly isn't in
// raw/interactive mode between turns) force-killed the WHOLE process via
// process.exit() here, bypassing the REPL's graceful "See you!" shutdown and
// its own turn-cancellation logic entirely — visible as Node's "Warning:
// Detected unsettled top-level await" at the bin/reagent.js entry point,
// since the process died mid-await instead of main() ever resolving.
let signalOwnerClaimed = false;
/** Called once by a CLI entry point (REPL/exec/serve) that manages its own
 * signal-driven shutdown/cancellation, so this fallback backs off instead of
 * racing it. PTY cleanup on ANY exit path is still guaranteed by the
 * unconditional process.on("exit", cleanup) below. */
export function claimSignalOwnership(): void {
  signalOwnerClaimed = true;
}
process.on("exit", cleanup);
for (const [sig, code] of [
  ["SIGTERM", 143],
  ["SIGINT", 130],
] as [NodeJS.Signals, number][]) {
  process.on(sig, () => {
    cleanup();
    if (!signalOwnerClaimed) process.exit(code);
  });
}

// Schemas offered to the model (the orchestrator imports these names).
export const EXEC_COMMAND_SCHEMA = {
  type: "function",
  function: {
    name: "exec_command",
    description:
      "Runs a command in a PTY. Returns the output, or a session id if the process is " +
      "still running after yield_time_ms (use it for dev servers, REPLs, watchers). " +
      "With session_id, polls an existing session for new output.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        yield_time_ms: {
          type: "integer",
          description: "How long to wait for output, in ms (250 to 60000)",
          default: 10000,
        },
        session_id: {
          type: "integer",
          description: "Existing session to poll (command is ignored)",
        },
      },
      required: ["command"],
    },
  },
} as const;

export const WRITE_STDIN_SCHEMA = {
  type: "function",
  function: {
    name: "write_stdin",
    description:
      "Writes characters to a running exec session and returns recent output. " +
      "Empty chars just polls. Send '\\n' to press Enter.",
    parameters: {
      type: "object",
      properties: {
        session_id: { type: "integer" },
        chars: { type: "string" },
        yield_time_ms: {
          type: "integer",
          description: "How long to wait for output, in ms (250 to 60000)",
          default: 3000,
        },
      },
      required: ["session_id", "chars"],
    },
  },
} as const;
