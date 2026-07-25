// Background bash tasks (run_in_background + task_output + task_stop):
// launch acknowledgment, log file, completion notification via the
// bgNotifyHost captured at launch time, tail/filter/stop behavior, and the
// permission gate running BEFORE the spawn.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { config } from "../src/config.js";
import { newTurnContext, runWithTurn } from "../src/turn-context.js";
import type { BgNotifyHost } from "../src/turn-context.js";
import {
  _resetTasks,
  getTask,
  launchBackgroundTask,
  listTasks,
  taskOutput,
  taskStop,
} from "../src/tools/background-tasks.js";
import { dispatch } from "../src/tools/index.js";

const originalRoot = config.root;
let project: string;

beforeEach(() => {
  project = config.setRoot(fs.mkdtempSync(path.join(os.tmpdir(), "reagent-bgtasks-")));
  config.autoApprove = true;
  config.contextFile = false;
});

afterEach(() => {
  _resetTasks();
  config.setRoot(originalRoot);
  fs.rmSync(project, { recursive: true, force: true });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(pred: () => boolean, ms = 5000): Promise<boolean> {
  const deadline = performance.now() + ms;
  while (performance.now() < deadline) {
    if (pred()) return true;
    await sleep(20);
  }
  return pred();
}

function taskIdFrom(ack: string): string {
  const m = /Started background task (\w+)/.exec(ack);
  expect(m, `no task id in: ${ack}`).not.toBeNull();
  return m![1]!;
}

describe("background tasks", () => {
  it("test_run_in_background_returns_immediately_and_logs", async () => {
    const start = performance.now();
    const ack = await dispatch("bash", '{"command": "echo bg-out; sleep 5", "run_in_background": true}');
    expect((performance.now() - start) / 1000).toBeLessThan(2);
    expect(ack).toContain("Started background task");
    expect(ack).toContain("Use task_output to check progress, task_stop to kill.");
    const id = taskIdFrom(ack);
    expect(ack).toContain(path.join(".reagent", "tasks", `${id}.log`));
    // output goes to the log, never through the dispatch cap
    await waitFor(() => {
      try {
        return fs.readFileSync(getTask(id)!.logPath, "utf8").includes("bg-out");
      } catch {
        return false;
      }
    });
    expect(fs.readFileSync(getTask(id)!.logPath, "utf8")).toContain("bg-out");
    expect(getTask(id)!.status).toBe("running");
  });

  it("test_completion_updates_status_and_exit_code", async () => {
    const ack = await dispatch("bash", '{"command": "echo done-ok", "run_in_background": true}');
    const id = taskIdFrom(ack);
    expect(await waitFor(() => getTask(id)!.status !== "running")).toBe(true);
    expect(getTask(id)!.status).toBe("completed");
    expect(getTask(id)!.exitCode).toBe(0);
    const failAck = await dispatch("bash", '{"command": "exit 3", "run_in_background": true}');
    const failId = taskIdFrom(failAck);
    expect(await waitFor(() => getTask(failId)!.status !== "running")).toBe(true);
    expect(getTask(failId)!.status).toBe("failed");
    expect(getTask(failId)!.exitCode).toBe(3);
  });

  it("test_notification_enqueued_on_host_captured_at_launch", async () => {
    const host: BgNotifyHost = { pendingBgNotifications: [] };
    const longSuffix = "y".repeat(200);
    await runWithTurn(newTurnContext({ bgNotifyHost: host }), () =>
      dispatch("bash", JSON.stringify({ command: `echo tail-marker # ${longSuffix}`, run_in_background: true })),
    );
    // the notification arrives AFTER the turn is gone (host was captured at launch)
    expect(await waitFor(() => host.pendingBgNotifications.length > 0)).toBe(true);
    const note = host.pendingBgNotifications[0]!;
    expect(note.startsWith("<task-notification>")).toBe(true);
    expect(note.endsWith("</task-notification>")).toBe(true);
    expect(note).toContain("finished with exit code 0");
    expect(note).toContain("Last output lines:\ntail-marker");
    // command truncated to 120 chars in the notification
    const quoted = /`([^`]*)`/.exec(note)![1]!;
    expect(quoted.length).toBeLessThanOrEqual(121); // 120 + ellipsis
    expect(quoted.endsWith("…")).toBe(true);
  });

  it("test_no_notification_without_host", async () => {
    const ack = await dispatch("bash", '{"command": "echo quiet", "run_in_background": true}');
    const id = taskIdFrom(ack);
    expect(await waitFor(() => getTask(id)!.status === "completed")).toBe(true);
    // nothing to assert beyond "did not throw": there is no host to receive it
  });

  it("test_task_output_lists_tasks_without_id", async () => {
    expect(taskOutput()).toBe("No background tasks.");
    const ack = await dispatch("bash", '{"command": "echo listed", "run_in_background": true}');
    const id = taskIdFrom(ack);
    await waitFor(() => getTask(id)!.status === "completed");
    const listing = taskOutput();
    expect(listing).toContain("Background tasks:");
    expect(listing).toContain(id);
    expect(listing).toContain("completed");
    expect(listTasks().map((t) => t.id)).toContain(id);
  });

  it("test_task_output_tail_and_filter", async () => {
    const ack = await dispatch(
      "bash",
      '{"command": "echo alpha-1; echo beta-2; echo alpha-3", "run_in_background": true}',
    );
    const id = taskIdFrom(ack);
    await waitFor(() => getTask(id)!.status === "completed");
    const full = await dispatch("task_output", JSON.stringify({ task_id: id }));
    expect(full).toContain("alpha-1");
    expect(full).toContain("beta-2");
    const filtered = await dispatch("task_output", JSON.stringify({ task_id: id, filter: "alpha" }));
    // the header echoes the command (which mentions beta-2); the log tail
    // after the "Log:" line must only contain the matching lines
    const tail = filtered.slice(filtered.indexOf("Log:"));
    expect(tail).toContain("alpha-1");
    expect(tail).toContain("alpha-3");
    expect(tail).not.toContain("\nbeta-2");
  });

  it("test_task_output_unknown_id_errors", async () => {
    const out = await dispatch("task_output", '{"task_id": "nope"}');
    expect(out).toContain("Error:");
    expect(out).toContain("unknown task 'nope'");
  });

  it("test_task_stop_kills_running_task", async () => {
    const ack = await dispatch("bash", '{"command": "sleep 30", "run_in_background": true}');
    const id = taskIdFrom(ack);
    const stop = await dispatch("task_stop", JSON.stringify({ task_id: id }));
    expect(stop).toContain(`Task ${id} killed`);
    expect(await waitFor(() => getTask(id)!.exitCode !== null)).toBe(true);
    expect(getTask(id)!.status).toBe("killed"); // exit handler does not overwrite the kill
    // stopping again reports the terminal state instead of signalling
    expect(taskStop(id)).toContain(`already killed`);
  });

  it("test_permission_gate_runs_before_spawn", async () => {
    // non-interactive without auto-approve: confirmBash denies, nothing spawns
    config.autoApprove = false;
    const out = await dispatch("bash", '{"command": "sleep 5", "run_in_background": true}');
    expect(out).toBe("User denied command execution.");
    expect(listTasks()).toEqual([]);
    expect(fs.existsSync(path.join(config.stateDir, "tasks"))).toBe(false);
  });

  it("test_direct_launch_requires_argv", () => {
    expect(() => launchBackgroundTask("x", [])).toThrow();
  });
});
