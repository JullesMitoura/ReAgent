/**
 * Unified kill switch for every process class a turn can leave behind:
 * foreground bash, exec_command PTYs, and run_in_background tasks.
 *
 * Call sites (server stop, REPL Ctrl+C, non-interactive cancel) used to only
 * invoke shell.killActive(), which left long-lived PTYs and background jobs
 * running after the user believed the turn had stopped.
 */

import { listTasks, taskStop } from "./background-tasks.js";
import { cleanup as cleanupExecSessions } from "./exec-sessions.js";
import { killActive } from "./shell.js";

/** Signals every tracked tool process. Idempotent; never throws. */
export function killAllToolProcesses(): number {
  let signaled = 0;
  try {
    signaled += killActive();
  } catch {
    // ignore
  }
  try {
    cleanupExecSessions();
  } catch {
    // ignore
  }
  try {
    for (const task of listTasks()) {
      if (task.status !== "running") continue;
      try {
        taskStop(task.id);
        signaled += 1;
      } catch {
        // unknown/raced task: ignore
      }
    }
  } catch {
    // ignore
  }
  return signaled;
}
