/**
 * Background bash tasks (Claude Code's `run_in_background` pattern).
 *
 * A background command is permission-gated like a normal bash call, then
 * spawned detached from the turn with stdout+stderr redirected to
 * .reagent/tasks/<task_id>.log. The tool returns immediately; the model checks
 * progress with task_output and kills with task_stop. Output never goes
 * through the dispatch cap: it lives in the log file.
 *
 * On completion, if the launching turn had a bgNotifyHost (the session), a
 * <task-notification> is enqueued in pendingBgNotifications; the main loop
 * drains it between rounds as a user message (same channel background
 * sub-agents already use). The host is captured AT LAUNCH TIME: by the time
 * the process exits the turn (and currentTurn()) is usually gone.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { config } from "../config.js";
import { scrubbedEnv } from "../lib/env-scrub.js";
import { currentTurn } from "../turn-context.js";
import type { BgNotifyHost } from "../turn-context.js";
import { ToolError } from "./errors.js";

export type BackgroundTaskStatus = "running" | "completed" | "failed" | "killed";

export interface BackgroundTask {
  id: string;
  pid: number | undefined;
  command: string;
  status: BackgroundTaskStatus;
  exitCode: number | null;
  /** epoch ms */
  startedAt: number;
  /** absolute path of the stdout+stderr log */
  logPath: string;
}

// Task registry + live process handles (handles are internal: they keep the
// "still alive?" check for the escalating kill honest).
const TASKS = new Map<string, BackgroundTask>();
const PROCS = new Map<string, ChildProcess>();

/** Snapshot of every known task (most recent first). */
export function listTasks(): BackgroundTask[] {
  return [...TASKS.values()].sort((a, b) => b.startedAt - a.startedAt);
}

export function getTask(taskId: string): BackgroundTask | undefined {
  return TASKS.get(taskId);
}

/** Test seam: kills any live task group and clears the registry. */
export function _resetTasks(): void {
  for (const [id, proc] of PROCS) {
    if (isAlive(proc) && proc.pid !== undefined) killGroup(proc.pid, "SIGKILL");
    PROCS.delete(id);
  }
  TASKS.clear();
}

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

// Never leak a background task past the process (same policy as shell.ts:
// on exit there is no grace time, SIGKILL directly on the groups still alive).
process.on("exit", () => {
  for (const proc of PROCS.values()) {
    if (isAlive(proc) && proc.pid !== undefined) killGroup(proc.pid, "SIGKILL");
  }
});

function relLog(task: BackgroundTask): string {
  return path.relative(config.root, task.logPath);
}

/** Last `n` lines of the task log (missing/unreadable log: empty string). */
function logTail(task: BackgroundTask, n: number): string {
  let text: string;
  try {
    text = fs.readFileSync(task.logPath, "utf8");
  } catch {
    return "";
  }
  const lines = text.replace(/\n$/, "").split("\n");
  return lines.slice(-n).join("\n");
}

function enqueueNotification(host: BgNotifyHost | null, task: BackgroundTask): void {
  if (host === null) return;
  const cmd = task.command.length > 120 ? task.command.slice(0, 120) + "…" : task.command;
  host.pendingBgNotifications.push(
    `<task-notification>Background command ${task.id} finished with exit code ` +
      `${task.exitCode ?? "unknown"}: \`${cmd}\`. Last output lines:\n` +
      `${logTail(task, 10)}</task-notification>`,
  );
}

/**
 * Spawns `argv` detached, logging to .reagent/tasks/<id>.log, and returns the
 * immediate acknowledgment for the model. The caller (bash tool) has already
 * run the permission gate; `command` is only used for display/notification.
 */
export function launchBackgroundTask(command: string, argv: string[]): string {
  if (argv.length === 0 || argv[0] === undefined) {
    throw new ToolError("empty command");
  }
  const tasksDir = path.join(config.stateDir, "tasks");
  fs.mkdirSync(tasksDir, { recursive: true });
  const id = randomBytes(3).toString("hex");
  const logPath = path.join(tasksDir, `${id}.log`);
  // Capture the notify host NOW: when the process exits the turn is gone.
  const host = currentTurn()?.bgNotifyHost ?? null;

  const fd = fs.openSync(logPath, "w");
  let proc: ChildProcess;
  try {
    proc = spawn(argv[0], argv.slice(1), {
      cwd: config.root,
      detached: true, // own process group: task_stop's kill reaches grandchildren
      stdio: ["ignore", fd, fd],
      env: scrubbedEnv(),
    });
  } finally {
    fs.closeSync(fd); // the child holds its own dup of the fd
  }

  const task: BackgroundTask = {
    id,
    pid: proc.pid,
    command,
    status: "running",
    exitCode: null,
    startedAt: Date.now(),
    logPath,
  };
  TASKS.set(id, task);
  PROCS.set(id, proc);

  let finished = false;
  const finish = (exitCode: number | null, failText?: string) => {
    if (finished) return;
    finished = true;
    task.exitCode = exitCode;
    if (task.status === "running") {
      task.status = exitCode === 0 ? "completed" : "failed";
    }
    if (failText) {
      try {
        fs.appendFileSync(logPath, failText + "\n");
      } catch {
        // log unwritable: the status/exit code still tell the story
      }
    }
    PROCS.delete(id);
    enqueueNotification(host, task);
  };
  proc.once("exit", (code, signal) => {
    const exitCode =
      code !== null ? code : signal !== null ? 128 + (os.constants.signals[signal] ?? 1) : null;
    finish(exitCode);
  });
  proc.once("error", (err) => finish(null, `spawn error: ${err.message}`));
  proc.unref(); // the event loop never waits on a background task

  return (
    `Started background task ${id} (log: ${relLog(task)}). ` +
    "Use task_output to check progress, task_stop to kill."
  );
}

// Tail returned by task_output (chars, after the optional line filter).
const OUTPUT_TAIL_CHARS = 2_000;

function statusLine(task: BackgroundTask): string {
  const exit = task.exitCode === null ? "" : ` (exit code ${task.exitCode})`;
  const pid = task.status === "running" && task.pid !== undefined ? ` (pid ${task.pid})` : "";
  const cmd = task.command.length > 120 ? task.command.slice(0, 120) + "…" : task.command;
  return `${task.id}: ${task.status}${exit}${pid} — \`${cmd}\``;
}

/**
 * Status + log tail of one background task; without task_id, lists all tasks.
 * `filter` keeps only log lines matching the regex before taking the tail.
 */
export function taskOutput(taskId?: string, filter?: string): string {
  if (taskId === undefined || taskId === "") {
    const tasks = listTasks();
    if (tasks.length === 0) return "No background tasks.";
    return ["Background tasks:", ...tasks.map((t) => `- ${statusLine(t)}`)].join("\n");
  }
  const task = TASKS.get(taskId);
  if (task === undefined) {
    throw new ToolError(`unknown task '${taskId}' (call task_output without task_id to list tasks)`);
  }
  let text: string;
  try {
    text = fs.readFileSync(task.logPath, "utf8");
  } catch {
    text = "";
  }
  if (filter) {
    let re: RegExp;
    try {
      re = new RegExp(filter);
    } catch {
      throw new ToolError(`invalid filter regex: ${filter}`);
    }
    text = text
      .split("\n")
      .filter((line) => re.test(line))
      .join("\n");
  }
  let tail = text;
  if (tail.length > OUTPUT_TAIL_CHARS) {
    tail = `… [${tail.length - OUTPUT_TAIL_CHARS} chars omitted] …\n` + tail.slice(-OUTPUT_TAIL_CHARS);
  }
  const header = `Task ${statusLine(task)}\nLog: ${relLog(task)}`;
  return tail ? `${header}\n${tail}` : `${header}\n(no output${filter ? " matching filter" : ""} yet)`;
}

/** Kills a running task's process group: SIGTERM now, SIGKILL after 2s if alive. */
export function taskStop(taskId: string): string {
  const task = TASKS.get(taskId);
  if (task === undefined) {
    throw new ToolError(`unknown task '${taskId}' (call task_output without task_id to list tasks)`);
  }
  if (task.status !== "running") {
    return `Task ${taskId} is already ${task.status}` +
      (task.exitCode !== null ? ` (exit code ${task.exitCode}).` : ".");
  }
  task.status = "killed";
  const proc = PROCS.get(taskId);
  if (task.pid !== undefined) {
    killGroup(task.pid, "SIGTERM");
    const pid = task.pid;
    const timer = setTimeout(() => {
      if (proc !== undefined && isAlive(proc)) killGroup(pid, "SIGKILL");
    }, 2000);
    timer.unref();
  }
  return `Task ${taskId} killed (SIGTERM sent; SIGKILL follows in 2s if still alive).`;
}
