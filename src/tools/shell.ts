/**
 * Port of src/tools/shell.py: bash tool with a sandbox-first flow (Codex model).
 *
 * Python -> Node adaptations (section 4.2 of MIGRATION_SPEC):
 * - subprocess.Popen(start_new_session=True) becomes spawn detached (own group);
 * - os.killpg becomes process.kill(-pid, signal);
 * - the _PipeReader threads become stream.on("data") + HeadTailBuffer per pipe,
 *   with a carry of incomplete UTF-8 between chunks;
 * - exit by signal arrives as a name (e.g. "SIGKILL"); the number comes from
 *   os.constants.signals to format "128+sig (NAME)".
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import os from "node:os";
import type { Readable } from "node:stream";

import { isDangerousCommand } from "../command-safety.js";
import { config } from "../config.js";
import { scrubbedEnv } from "../lib/env-scrub.js";
import { HeadTailBuffer, capHeadTail, holdIncompleteUtf8 } from "../lib/head-tail-buffer.js";
import { confirmBash, denialMessage } from "../permissions.js";
import { available, looksLikeDenial, shellArgv, wrap } from "../sandbox.js";
import { launchBackgroundTask } from "./background-tasks.js";

// Character limit of the combined result (stdout+stderr). High on
// purpose: it limits only the transient MEMORY; the dispatch cuts what goes to
// the model at MAX_TOOL_OUTPUT and saves the excess in .reagent/truncations.
export const MAX_OUTPUT = 2_000_000;

// Effective value of the cap, mutable only by the tests (mirrors the
// monkeypatch of shell.MAX_OUTPUT in Python).
let maxOutput: number = MAX_OUTPUT;

/** Test seam: swaps the effective cap; null returns to MAX_OUTPUT. */
export function _setMaxOutput(value: number | null): void {
  maxOutput = value ?? MAX_OUTPUT;
}

// Live bash processes, by pid: killActive() (server stop, REPL Ctrl+C)
// kills the registered groups; _ABORTED marks who died by user abort.
// Exported for the tests (same internal names as Python).
export const _ACTIVE = new Map<number, ChildProcess>();
export const _ABORTED = new Set<number>();

function isAlive(proc: ChildProcess): boolean {
  return proc.exitCode === null && proc.signalCode === null;
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // group already dead or without permission: ignore
  }
}

/**
 * Kills the process group of each active bash (SIGTERM, then SIGKILL).
 *
 * API for the server stop and the REPL Ctrl+C. Returns how many processes
 * were signaled; the in-flight _run calls resolve with the partial output and
 * the abort mark. Node adaptation: the half second of grace before the
 * SIGKILL is a setTimeout (it does not block the event loop, which needs to
 * spin for the process exit to be observed).
 */
export function killActive(): number {
  const procs = [..._ACTIVE.values()];
  let killed = 0;
  for (const proc of procs) {
    if (!isAlive(proc) || proc.pid === undefined) continue;
    _ABORTED.add(proc.pid);
    killed += 1;
    killGroup(proc.pid, "SIGTERM");
  }
  if (killed) {
    const timer = setTimeout(() => {
      for (const proc of procs) {
        if (isAlive(proc) && proc.pid !== undefined) {
          killGroup(proc.pid, "SIGKILL");
        }
      }
    }, 500);
    timer.unref();
  }
  return killed;
}

// Never leak a long-running bash on exit (Python's atexit). On exit there is
// no grace time: SIGKILL directly on the groups still alive.
process.on("exit", () => {
  for (const proc of _ACTIVE.values()) {
    if (isAlive(proc) && proc.pid !== undefined) {
      killGroup(proc.pid, "SIGKILL");
    }
  }
});

/** Formats the exit; death by signal becomes 128+signal with the name (shell style). */
function exitCodeStr(code: number | null, signal: NodeJS.Signals | null): string {
  if (signal !== null) {
    const num = os.constants.signals[signal];
    if (num !== undefined) return `${128 + num} (${signal})`;
    return `(${signal})`;
  }
  return String(code);
}

/**
 * Incremental reader of a pipe: tolerant UTF-8 with carry + head/tail cap.
 *
 * An independent buffer per pipe: stderr never disappears under a giant stdout
 * and binary output does not break (toString("utf8") replaces invalid bytes).
 */
class PipeReader {
  private readonly stream: Readable;
  private readonly cap: number;
  private readonly buf: HeadTailBuffer;
  private readonly ended: Promise<void>;
  private carry: Buffer = Buffer.alloc(0);
  private total = 0;
  private newlines = 0;
  private lastByte: number | null = null;

  constructor(stream: Readable) {
    this.stream = stream;
    this.cap = maxOutput;
    this.buf = new HeadTailBuffer(this.cap);
    this.ended = new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        if (this.carry.length) {
          const text = this.carry.toString("utf8");
          this.buf.append(text);
          this.total += text.length;
          this.carry = Buffer.alloc(0);
        }
        resolve();
      };
      stream.on("data", (chunk: Buffer) => {
        let idx = chunk.indexOf(0x0a);
        while (idx !== -1) {
          this.newlines += 1;
          idx = chunk.indexOf(0x0a, idx + 1);
        }
        if (chunk.length) this.lastByte = chunk[chunk.length - 1] ?? null;
        const [whole, carry] = holdIncompleteUtf8(Buffer.concat([this.carry, chunk]));
        this.carry = carry;
        const text = whole.toString("utf8");
        if (text) {
          this.buf.append(text);
          this.total += text.length;
        }
      });
      stream.on("end", finish);
      stream.on("close", finish);
      stream.on("error", finish);
    });
  }

  /** Waits for EOF up to drainSec and returns [text, was_cut, total_lines]. */
  async finish(drainSec: number): Promise<[string, boolean, number]> {
    const arrived = await waitFor(this.ended, drainSec * 1000);
    if (!arrived) {
      // always close the pipe: unblocks a reader stuck on a grandchild that
      // holds the fd and leaves no dangling handles
      this.stream.destroy();
      await waitFor(this.ended, 500);
    }
    // omitted > 0 in the buffer happens exactly when the appended total
    // passed the cap (equivalent to the buf.omitted read by Python)
    const cut = this.total > this.cap;
    const text = this.buf.take();
    const lines = this.newlines + (this.lastByte !== null && this.lastByte !== 0x0a ? 1 : 0);
    return [text, cut, lines];
  }
}

function waitFor(p: Promise<void>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    timer.unref();
    void p.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

const TIMEOUT = Symbol("timeout");

function timeoutAfter(ms: number): Promise<typeof TIMEOUT> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(TIMEOUT), ms);
    timer.unref();
  });
}

interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/**
 * Runs the argv and formats the output (equivalent of Python's _run; always
 * explicit argv, never shell:true).
 *
 * Returns [exit_code, text]. exit_code null means timeout or abort by the
 * user (the whole process group is killed so that grandchildren do not
 * survive). Success comes with a structured header: Exit code, Wall time and,
 * if it truncated, the total number of lines.
 */
async function run(argv: string[], timeout: number): Promise<[number | null, string]> {
  if (argv.length === 0 || argv[0] === undefined) {
    return [null, "Error: empty command"];
  }
  const start = performance.now();
  const proc = spawn(argv[0], argv.slice(1), {
    cwd: config.root,
    detached: true, // own process group: the kill reaches grandchildren
    stdio: ["ignore", "pipe", "pipe"],
    env: scrubbedEnv(),
  });
  const exited: Promise<ExitInfo> = new Promise((resolve, reject) => {
    proc.once("exit", (code, signal) => resolve({ code, signal }));
    proc.once("error", (err) => reject(err));
  });
  // the timeout race can abandon the promise; never let it become an unhandled rejection
  exited.catch(() => {});
  const outReader = new PipeReader(proc.stdout as Readable);
  const errReader = new PipeReader(proc.stderr as Readable);
  const pid = proc.pid;
  if (pid !== undefined) {
    _ACTIVE.set(pid, proc);
    _ABORTED.delete(pid); // a reused pid does not inherit an old abort
  }
  let timedOut = false;
  let aborted = false;
  let exit: ExitInfo = { code: null, signal: null };
  try {
    const first = await Promise.race([exited, timeoutAfter(timeout * 1000)]);
    if (first === TIMEOUT) {
      timedOut = true;
      if (pid !== undefined) killGroup(pid, "SIGKILL");
      const second = await Promise.race([exited, timeoutAfter(2000)]);
      if (second !== TIMEOUT) exit = second;
    } else {
      exit = first;
    }
  } finally {
    if (pid !== undefined) {
      _ACTIVE.delete(pid);
      aborted = _ABORTED.has(pid);
      _ABORTED.delete(pid);
    }
  }
  const wall = (performance.now() - start) / 1000;

  // timeout gets a longer drain (2s) to collect the partial output post-kill
  const drain = timedOut ? 2.0 : 1.0;
  const [outRes, errRes] = await Promise.all([outReader.finish(drain), errReader.finish(drain)]);
  let [out] = outRes;
  const [, outCut, outLines] = outRes;
  let [err] = errRes;
  const [, errCut, errLines] = errRes;

  const overflow = out.length + err.length > maxOutput;
  const truncated = outCut || errCut || overflow;
  if (overflow) {
    // final recap: ensures the [stderr] survives under a giant stdout
    out = capHeadTail(out, Math.floor(maxOutput / 3));
    err = capHeadTail(err, Math.floor((2 * maxOutput) / 3));
  }
  const parts: string[] = [];
  if (out) parts.push(out);
  if (err) parts.push(`[stderr]\n${err}`);
  const body = parts.join("\n");

  if (aborted) {
    // exit code null: an abort does not trigger the unsandboxed retry in bash()
    let text = "(command aborted by user)";
    if (body) text += `\n${body}`;
    return [null, text];
  }

  if (timedOut) {
    let text = `Command timed out after ${timeout}s and the process group was killed.`;
    if (body) text += `\n${body}`;
    return [null, `${text}\n[exit code: 124]`];
  }

  const header = [
    `Exit code: ${exitCodeStr(exit.code, exit.signal)}`,
    `Wall time: ${wall.toFixed(1)} seconds`,
  ];
  if (truncated) {
    header.push(`Total output lines: ${outLines + errLines}`);
  }
  if (body) {
    header.push("Output:");
    header.push(body);
  }
  const returncode =
    exit.signal !== null ? -(os.constants.signals[exit.signal] ?? 1) : exit.code;
  return [returncode, header.join("\n")];
}

export interface BashOptions {
  /** Model's 5-10 word summary of the command, shown in the permission prompt. */
  description?: string;
  /** True: launch detached, log to .reagent/tasks/<id>.log, return immediately. */
  runInBackground?: boolean;
}

/**
 * Codex-style flow: sandbox first, approval only on failure.
 *
 * 1. Dangerous command: always asks; if approved, runs WITHOUT sandbox (the
 *    user's explicit approval is the authorization).
 * 2. Sandbox available: runs contained DIRECTLY, without asking (the
 *    containment is the permission). If the output looks like a Seatbelt
 *    denial, then it asks; if approved, re-executes outside the sandbox.
 * 3. No sandbox: classic flow with confirmBash.
 *
 * run_in_background short-circuits the sandbox flow: permission is checked
 * upfront and the command runs detached via background-tasks.ts.
 */
export async function bash(
  command: string,
  timeout: number = 120,
  opts: BashOptions = {},
): Promise<string> {
  if (!command || !command.trim()) {
    return "Error: empty command";
  }
  const effectiveTimeout = Math.min(timeout, 600);
  const { description } = opts;

  if (opts.runInBackground) {
    // Background commands always run UNSANDBOXED but keep the full permission
    // gate upfront (confirmBash still auto-allows known-safe commands and
    // hard-gates dangerous ones). The sandbox-first flow cannot apply here:
    // it depends on detecting a Seatbelt denial in the output and re-asking
    // the user for an unsandboxed retry, which is impossible once the process
    // is detached from the turn.
    if (!(await confirmBash(command, description))) {
      return denialMessage("User denied command execution.");
    }
    return launchBackgroundTask(command, shellArgv(command));
  }

  if (isDangerousCommand(command)) {
    if (!(await confirmBash(command, description))) {
      // cancel/timeout swap the "User denied" for a neutral message
      return denialMessage("User denied command execution.");
    }
    const [, result] = await run(shellArgv(command), effectiveTimeout);
    return result;
  }

  if (available()) {
    const [code, result] = await run(wrap(command), effectiveTimeout);
    if (code !== null && looksLikeDenial(code, result)) {
      if (await confirmBash(command, description)) {
        const [, retry] = await run(shellArgv(command), effectiveTimeout);
        return `[ran unsandboxed after approval]\n${retry}`;
      }
      const denial = denialMessage("user denied unsandboxed run");
      return `[blocked by sandbox; ${denial}]\n${result}`;
    }
    return result;
  }

  if (!(await confirmBash(command, description))) {
    // cancel/timeout swap "User denied" for a neutral message
    return denialMessage("User denied command execution.");
  }
  const [, result] = await run(shellArgv(command), effectiveTimeout);
  return result;
}
