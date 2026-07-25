// Situational reminder injection: priority order, external-modification
// warning, todo staleness enforcement and the verify-before-done nudge.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { recordRead, resetReadState } from "../src/agent/read-state.js";
import {
  REMINDER_DENIAL,
  REMINDER_FILE_MODIFIED,
  REMINDER_TODO_STALE,
  REMINDER_TRUNCATED_READ,
  REMINDER_VERIFY_BEFORE_DONE,
} from "../src/prompts/reminders/index.js";
import {
  reminderMessageForRound,
  resetReminderRounds,
} from "../src/prompts/reminders/inject.js";
import { consumeCompletionBurst, setTodos, todoWrite } from "../src/tools/todo.js";
import type { TodoItem } from "../src/types.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reagent-rem-"));
  resetReadState();
  resetReminderRounds();
  setTodos([]);
  consumeCompletionBurst(); // drain leftovers from other tests
});

afterEach(() => {
  resetReadState();
  resetReminderRounds();
  setTodos([]);
  fs.rmSync(tmp, { recursive: true, force: true });
});

const OK_ROUND = [{ name: "read_file", result: "ok" }];

function modifiedFile(): string {
  const p = path.join(tmp, "mod.txt");
  fs.writeFileSync(p, "v1");
  recordRead(p);
  const future = new Date(Date.now() + 5_000);
  fs.utimesSync(p, future, future);
  return p;
}

function openTodos(): TodoItem[] {
  return [
    { content: "a", status: "in_progress" },
    { content: "b", status: "pending" },
  ];
}

describe("reminders", () => {
  it("quiet round yields no reminder", () => {
    expect(reminderMessageForRound(OK_ROUND)).toBeNull();
  });

  it("external modification injects the file-modified reminder once", () => {
    const p = modifiedFile();
    const msg = reminderMessageForRound(OK_ROUND);
    expect(msg?.content).toBe(REMINDER_FILE_MODIFIED([p]));
    expect(reminderMessageForRound(OK_ROUND)).toBeNull(); // notified once
  });

  it("a denial outranks the file-modified reminder, which fires next round", () => {
    const p = modifiedFile();
    const denied = [{ name: "shell", result: "User denied bash permission." }];
    expect(reminderMessageForRound(denied)?.content).toBe(REMINDER_DENIAL);
    // not swallowed: still pending on the following round
    expect(reminderMessageForRound(OK_ROUND)?.content).toBe(REMINDER_FILE_MODIFIED([p]));
  });

  it("file-modified outranks a truncated read", () => {
    const p = modifiedFile();
    const truncated = [{ name: "read_file", result: "abc (output truncated at 100 lines)" }];
    expect(reminderMessageForRound(truncated)?.content).toBe(REMINDER_FILE_MODIFIED([p]));
  });

  // --- todo staleness ----------------------------------------------------------

  it("stale todos: nudges after 10 rounds without todowrite, rate-limited", () => {
    setTodos(openTodos());
    for (let i = 0; i < 9; i++) {
      expect(reminderMessageForRound(OK_ROUND)).toBeNull();
    }
    expect(reminderMessageForRound(OK_ROUND)?.content).toBe(REMINDER_TODO_STALE);
    // rate limit: silent for the next 9 rounds, fires again on the 10th
    for (let i = 0; i < 9; i++) {
      expect(reminderMessageForRound(OK_ROUND)).toBeNull();
    }
    expect(reminderMessageForRound(OK_ROUND)?.content).toBe(REMINDER_TODO_STALE);
  });

  it("no nudge when the todo list is empty or fully completed", () => {
    setTodos([{ content: "done", status: "completed" }]);
    for (let i = 0; i < 25; i++) {
      expect(reminderMessageForRound(OK_ROUND)).toBeNull();
    }
  });

  it("a successful todowrite resets the staleness counter", () => {
    setTodos(openTodos());
    for (let i = 0; i < 9; i++) reminderMessageForRound(OK_ROUND);
    // round 10 contains a todowrite: counter resets, no stale nudge
    const round = [{ name: "todowrite", result: "Todo list updated (0/2 completed)" }];
    expect(reminderMessageForRound(round)).toBeNull();
    for (let i = 0; i < 9; i++) {
      expect(reminderMessageForRound(OK_ROUND)).toBeNull();
    }
    expect(reminderMessageForRound(OK_ROUND)?.content).toBe(REMINDER_TODO_STALE);
  });

  // --- verify-before-done nudge --------------------------------------------------

  it("closing 3+ todos at once injects the verify nudge", () => {
    setTodos([
      { content: "a", status: "in_progress" },
      { content: "b", status: "pending" },
      { content: "c", status: "pending" },
    ]);
    todoWrite([
      { content: "a", status: "completed" },
      { content: "b", status: "completed" },
      { content: "c", status: "completed" },
    ]);
    const round = [{ name: "todowrite", result: "Todo list updated (3/3 completed)" }];
    expect(reminderMessageForRound(round)?.content).toBe(REMINDER_VERIFY_BEFORE_DONE);
    expect(reminderMessageForRound(OK_ROUND)).toBeNull(); // burst consumed
  });

  it("closing fewer than 3 todos does not nudge", () => {
    setTodos([
      { content: "a", status: "in_progress" },
      { content: "b", status: "completed" },
      { content: "c", status: "pending" },
    ]);
    todoWrite([
      { content: "a", status: "completed" },
      { content: "b", status: "completed" }, // already completed before: not a new close
      { content: "c", status: "completed" },
    ]);
    const round = [{ name: "todowrite", result: "Todo list updated (3/3 completed)" }];
    expect(reminderMessageForRound(round)).toBeNull();
  });

  it("a denial outranks the verify nudge", () => {
    setTodos([
      { content: "a", status: "pending" },
      { content: "b", status: "pending" },
      { content: "c", status: "pending" },
    ]);
    todoWrite([
      { content: "a", status: "completed" },
      { content: "b", status: "completed" },
      { content: "c", status: "completed" },
    ]);
    const round = [{ name: "shell", result: "User denied bash permission." }];
    expect(reminderMessageForRound(round)?.content).toBe(REMINDER_DENIAL);
    // burst not consumed by the higher-priority reminder: nudges next round
    expect(reminderMessageForRound(OK_ROUND)?.content).toBe(REMINDER_VERIFY_BEFORE_DONE);
  });
});
