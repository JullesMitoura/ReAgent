/**
 * Situational reminder injection (Claude Code system-reminder pattern).
 *
 * After a round of tool results, the loop may append ONE short user-role reminder
 * that nudges the model without polluting the stable system prefix. Kept separate
 * from the static reminder strings (index.ts) so both the streaming loop
 * (agent/query.ts) and the sub-agent loop (agent/tool-loop.ts) share one policy.
 */

import { checkExternalModifications } from "../../agent/read-state.js";
import { consumeCompletionBurst, getTodos } from "../../tools/todo.js";
import type { ChatMessage } from "../../types.js";
import {
  REMINDER_AGENT_LAUNCHED,
  REMINDER_DENIAL,
  REMINDER_FILE_MODIFIED,
  REMINDER_TODO_STALE,
  REMINDER_TRUNCATED_READ,
  REMINDER_VERIFY_BEFORE_DONE,
  asReminderMessage,
} from "./index.js";

/** Tools whose invocation means a sub-agent is now doing work out of band. */
const DELEGATION_TOOLS = new Set(["agent", "explore", "parallel_agents", "plan", "workflow"]);

// Todo enforcement (Claude Code pattern): after this many tool rounds without
// a successful todowrite while open items exist, nudge the model to update the
// list. The same interval rate-limits the nudge itself.
const TODO_STALE_ROUNDS = 10;

/** Newly-completed items in one todowrite that trigger the verify nudge. */
const VERIFY_BURST_MIN = 3;

let roundsSinceTodoWrite = 0;
let roundsSinceStaleReminder = TODO_STALE_ROUNDS; // first nudge is not rate-limited

/** Clears the round counters (tests). */
export function resetReminderRounds(): void {
  roundsSinceTodoWrite = 0;
  roundsSinceStaleReminder = TODO_STALE_ROUNDS;
}

function hasOpenTodos(): boolean {
  return getTodos().some((t) => t.status === "pending" || t.status === "in_progress");
}

function looksDenied(result: string): boolean {
  const r = result.trimStart();
  return /^user denied/i.test(r) || r.startsWith("(dangerous command blocked");
}

function looksTruncated(result: string): boolean {
  return result.includes("(output truncated") || /\.\.\. \[\d+ chars omitted\] \.\.\./.test(result);
}

function launchedBackgroundAgent(name: string, result: string): boolean {
  if (!DELEGATION_TOOLS.has(name)) return false;
  // Background launches return an immediate ack; foreground calls return the report.
  return /background agent .* started/i.test(result);
}

/**
 * Picks at most one reminder for the round, by priority: denial (adjust, don't
 * retry) > file modified externally (re-read, don't revert) > background launch
 * (don't duplicate / don't fabricate) > truncated read (re-read the slice,
 * don't guess) > verify nudge (many todos closed at once) > stale todo list.
 * Returns null when nothing applies.
 */
export function reminderMessageForRound(
  results: Array<{ name: string; result: string }>,
): ChatMessage | null {
  const wroteTodos = results.some(
    (r) => r.name === "todowrite" && !r.result.startsWith("Error"),
  );
  roundsSinceTodoWrite = wroteTodos ? 0 : roundsSinceTodoWrite + 1;
  roundsSinceStaleReminder += 1;

  if (results.some((r) => looksDenied(r.result))) {
    return asReminderMessage(REMINDER_DENIAL) as ChatMessage;
  }
  const modified = checkExternalModifications();
  if (modified.length > 0) {
    return asReminderMessage(REMINDER_FILE_MODIFIED(modified)) as ChatMessage;
  }
  if (results.some((r) => launchedBackgroundAgent(r.name, r.result))) {
    return asReminderMessage(REMINDER_AGENT_LAUNCHED) as ChatMessage;
  }
  if (results.some((r) => looksTruncated(r.result))) {
    return asReminderMessage(REMINDER_TRUNCATED_READ) as ChatMessage;
  }
  if (consumeCompletionBurst() >= VERIFY_BURST_MIN) {
    return asReminderMessage(REMINDER_VERIFY_BEFORE_DONE) as ChatMessage;
  }
  if (
    roundsSinceTodoWrite >= TODO_STALE_ROUNDS &&
    roundsSinceStaleReminder >= TODO_STALE_ROUNDS &&
    hasOpenTodos()
  ) {
    roundsSinceStaleReminder = 0;
    return asReminderMessage(REMINDER_TODO_STALE) as ChatMessage;
  }
  return null;
}

export interface TaskNotification {
  id: string;
  title: string;
  status: "completed" | "failed" | "killed";
  summary: string;
  result?: string;
}

/**
 * Formats a background-agent completion as a <task-notification> block, delivered
 * to the parent as a user-role message (Claude Code / coordinator pattern). The
 * parent must treat it as an internal signal: relay findings, never fabricate them.
 */
export function formatTaskNotification(n: TaskNotification): string {
  const lines = [
    "<task-notification>",
    `<task-id>${n.id}</task-id>`,
    `<status>${n.status}</status>`,
    `<summary>${n.summary}</summary>`,
  ];
  if (n.result !== undefined && n.result !== "") {
    lines.push(`<result>\n${n.result}\n</result>`);
  }
  lines.push("</task-notification>");
  return lines.join("\n");
}
