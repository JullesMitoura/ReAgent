/**
 * Tool concurrency metadata + batch orchestration.
 *
 * Consecutive isConcurrencySafe tools run via Promise.all; unsafe tools run
 * alone (serial). Results are always keyed by tool_call id; callers append
 * history in the original call order (Codex-style pattern).
 */

import { config } from "../config.js";
import { mapLimit } from "../lib/pool.js";
import type { ToolCall } from "../types.js";
import { dispatch, READ_ONLY_TOOLS } from "./index.js";

export interface ToolMeta {
  name: string;
  /** Default false (fail-closed). Safe tools may run concurrently. */
  isConcurrencySafe: boolean;
  isReadOnly?: boolean;
  /** When true, permission gate may prompt (unless mode/yolo bypasses). */
  needsPermissions?: boolean;
  permissionKind?: "bash" | "write" | "edit" | "delete";
}

/** Built-in concurrency / permission metadata; unknown tools are fail-closed (serial). */
const TOOL_META: Record<string, ToolMeta> = {
  read_file: { name: "read_file", isConcurrencySafe: true, isReadOnly: true },
  list_dir: { name: "list_dir", isConcurrencySafe: true, isReadOnly: true },
  glob: { name: "glob", isConcurrencySafe: true, isReadOnly: true },
  grep: { name: "grep", isConcurrencySafe: true, isReadOnly: true },
  todoread: { name: "todoread", isConcurrencySafe: true, isReadOnly: true },
  webfetch: { name: "webfetch", isConcurrencySafe: true, isReadOnly: true },
  skill: { name: "skill", isConcurrencySafe: true, isReadOnly: true },
  write_file: {
    name: "write_file",
    isConcurrencySafe: false,
    needsPermissions: true,
    permissionKind: "write",
  },
  edit_file: {
    name: "edit_file",
    isConcurrencySafe: false,
    needsPermissions: true,
    permissionKind: "edit",
  },
  multi_edit: {
    name: "multi_edit",
    isConcurrencySafe: false,
    needsPermissions: true,
    permissionKind: "edit",
  },
  delete_file: {
    name: "delete_file",
    isConcurrencySafe: false,
    needsPermissions: true,
    permissionKind: "delete",
  },
  apply_patch: {
    name: "apply_patch",
    isConcurrencySafe: false,
    needsPermissions: true,
    permissionKind: "edit",
  },
  bash: {
    name: "bash",
    isConcurrencySafe: false,
    needsPermissions: true,
    permissionKind: "bash",
  },
  // Background-task inspection is pure read (registry + log tail); stopping a
  // task mutates process state, so it stays serial.
  task_output: { name: "task_output", isConcurrencySafe: true, isReadOnly: true },
  task_stop: { name: "task_stop", isConcurrencySafe: false },
  todowrite: { name: "todowrite", isConcurrencySafe: false },
  question: { name: "question", isConcurrencySafe: false },
  remember: { name: "remember", isConcurrencySafe: false },
  exec_command: {
    name: "exec_command",
    isConcurrencySafe: false,
    needsPermissions: true,
    permissionKind: "bash",
  },
  write_stdin: { name: "write_stdin", isConcurrencySafe: false },
  explore: { name: "explore", isConcurrencySafe: true, isReadOnly: true },
  parallel_agents: { name: "parallel_agents", isConcurrencySafe: false },
  agent: { name: "agent", isConcurrencySafe: true },
  plan: { name: "plan", isConcurrencySafe: true, isReadOnly: true },
  exit_plan_mode: { name: "exit_plan_mode", isConcurrencySafe: false, isReadOnly: true },
  tool_search: { name: "tool_search", isConcurrencySafe: true, isReadOnly: true },
  workflow: { name: "workflow", isConcurrencySafe: false },
};

/** Register or override concurrency metadata for a tool. */
export function registerToolMeta(meta: ToolMeta): void {
  TOOL_META[meta.name] = meta;
}

export function getToolMeta(name: string): ToolMeta {
  return (
    TOOL_META[name] ??
    TOOL_META[name.toLowerCase()] ?? {
      name,
      isConcurrencySafe: READ_ONLY_TOOLS.has(name),
      isReadOnly: READ_ONLY_TOOLS.has(name),
    }
  );
}

export function isConcurrencySafe(name: string): boolean {
  return getToolMeta(name).isConcurrencySafe;
}

/**
 * Sub-agent types safe to run concurrently: they never write files, so parallel
 * `agent` calls of these cannot race. Any other type (general-purpose,
 * coordinator-worker, worker, or a disk agent with write tools) is serialized.
 */
const READ_ONLY_AGENT_TYPES: ReadonlySet<string> = new Set(["explore", "plan", "verification"]);

/**
 * Argument-aware concurrency safety (tool input is parsed before deciding).
 * The `agent` tool is only safe to parallelize when it launches a read-only agent
 * type, or when background=true (it returns an immediate ack, doing no work inline).
 * A write-capable foreground agent is serialized so two of them cannot edit at once.
 */
export function isCallConcurrencySafe(name: string, argumentsJson?: string): boolean {
  if (name !== "agent") return isConcurrencySafe(name);
  try {
    const a = JSON.parse(argumentsJson || "{}") as Record<string, unknown>;
    if (a["background"] === true) return true;
    return READ_ONLY_AGENT_TYPES.has(String(a["subagent_type"] ?? ""));
  } catch {
    return false; // unparseable args → serialize (fail-closed)
  }
}

/** Partition tool calls into consecutive safe batches and singleton unsafe batches. */
export function partitionToolBatches(toolCalls: ToolCall[]): ToolCall[][] {
  const batches: ToolCall[][] = [];
  let current: ToolCall[] = [];
  for (const tc of toolCalls) {
    if (isCallConcurrencySafe(tc.function.name, tc.function.arguments)) {
      current.push(tc);
    } else {
      if (current.length) {
        batches.push(current);
        current = [];
      }
      batches.push([tc]);
    }
  }
  if (current.length) batches.push(current);
  return batches;
}

/**
 * Runs tool calls with concurrency partitioning; returns {id: result}.
 * Preserves call-order semantics for the caller when appending history.
 */
export async function runToolBatches(toolCalls: ToolCall[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (toolCalls.length === 0) return out;

  // Fast path: entire round concurrency-safe → one bounded fan-out.
  if (
    toolCalls.length > 1 &&
    toolCalls.every((tc) => isCallConcurrencySafe(tc.function.name, tc.function.arguments))
  ) {
    const results = await mapLimit(toolCalls, config.maxToolConcurrency, (tc) =>
      dispatch(tc.function.name, tc.function.arguments),
    );
    toolCalls.forEach((tc, i) => {
      out[tc.id] = results[i]!;
    });
    return out;
  }

  // Mixed rounds: partition into safe batches + serial unsafe.
  for (const batch of partitionToolBatches(toolCalls)) {
    if (batch.length === 1) {
      const tc = batch[0]!;
      out[tc.id] = await dispatch(tc.function.name, tc.function.arguments);
    } else {
      const results = await mapLimit(batch, config.maxToolConcurrency, (tc) =>
        dispatch(tc.function.name, tc.function.arguments),
      );
      batch.forEach((tc, i) => {
        out[tc.id] = results[i]!;
      });
    }
  }
  return out;
}
