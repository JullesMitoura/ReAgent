/**
 * Port of src/tools/todo.py: a task list the LLM maintains while it works
 * (opencode style).
 *
 * Module state as in Python (CONTRACTS.md, note 8): the Agent calls
 * setTodos(session.todos) in the constructor. Known race risk between
 * concurrent sessions, accepted for parity.
 */

import type { TodoItem, TodoStatus } from "../types.js";
import { ToolError } from "./errors.js";

const VALID_STATUS: ReadonlySet<string> = new Set(["pending", "in_progress", "completed"]);
const ICONS: Record<TodoStatus, string> = {
  pending: "○",
  in_progress: "◐",
  completed: "●",
};

let TODOS: TodoItem[] = [];

// Items newly marked completed by the latest todoWrite (vs. the previous
// state). The reminder injector consumes this to nudge verification when many
// items are closed at once.
let lastCompletionBurst = 0;

export function setTodos(todos: TodoItem[]): void {
  TODOS = todos ?? [];
}

/** Newly-completed count from the last todowrite; reading resets it to 0. */
export function consumeCompletionBurst(): number {
  const n = lastCompletionBurst;
  lastCompletionBurst = 0;
  return n;
}

export function getTodos(): TodoItem[] {
  return TODOS;
}

export function render(todos?: TodoItem[] | null): string {
  const items = todos == null ? TODOS : todos;
  if (!items.length) return "(no tasks)";
  return items.map((t) => `${ICONS[t.status]} ${t.content}`).join("\n");
}

export function todoWrite(todos: TodoItem[]): string {
  if (!Array.isArray(todos)) {
    throw new ToolError("each task needs 'content' and 'status'");
  }
  for (const t of todos as unknown[]) {
    if (
      typeof t !== "object" ||
      t === null ||
      Array.isArray(t) ||
      !("content" in t) ||
      !("status" in t)
    ) {
      throw new ToolError("each task needs 'content' and 'status'");
    }
    const status = (t as { status: unknown }).status;
    if (typeof status !== "string" || !VALID_STATUS.has(status)) {
      throw new ToolError(
        `invalid status '${String(status)}' (use: ${[...VALID_STATUS].sort().join(", ")})`,
      );
    }
  }
  const previouslyCompleted = new Set(
    TODOS.filter((t) => t.status === "completed").map((t) => t.content),
  );
  lastCompletionBurst = todos.filter(
    (t) => t.status === "completed" && !previouslyCompleted.has(t.content),
  ).length;
  setTodos(todos);
  const done = todos.filter((t) => t.status === "completed").length;
  return `Todo list updated (${done}/${todos.length} completed):\n${render(todos)}`;
}

export function todoRead(): string {
  return render();
}
