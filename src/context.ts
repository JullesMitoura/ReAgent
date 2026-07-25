/**
 * Context packing (port of src/context.py).
 *
 * Reduces tokens re-sent to the LLM per turn without calling the model: recent
 * messages stay intact; OLD and large tool results, and the bulky arguments of
 * old write_file/edit_file calls, become a short stub (head + note). Non-destructive:
 * operates on a copy; when nothing is trimmed it returns the SAME reference
 * (stable prefix, provider prefix cache).
 */

import type { ChatMessage, ToolCall, ToolCallFunction } from "./types.js";
import { config } from "./config.js";

// cost (chars) of the trim note; guarantees that trimming never grows the payload
const STUB_OVERHEAD = 120;

// first line of the user message that carries the compaction summary (lives
// here to avoid a circular import: agent imports context)
export const SUMMARY_MARKER = "[Summary of the earlier conversation (history compacted)]";

// tools whose arguments carry full file content
const PRUNABLE_ARG_TOOLS: ReadonlySet<string> = new Set(["write_file", "edit_file"]);
const PRUNABLE_ARG_FIELDS = ["content", "old_string", "new_string"] as const;

/** Replaces a large tool result with head + trim note. */
function stubToolContent(content: string, head: number): string {
  const kept = content.slice(0, head).trimEnd();
  return (
    `${kept}\n… [older tool output trimmed to save context: ` +
    `${content.length} chars total; call the tool again if you need the full result]`
  );
}

/**
 * Trims the bulky argument fields of an old write_file/edit_file.
 * Returns the trimmed JSON (deterministic), or null when there is nothing to trim
 * or the JSON is invalid: in that case the caller keeps the message intact.
 */
function stubCallArguments(argumentsJson: string, head: number): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const args = parsed as Record<string, unknown>;
  let trimmed = false;
  for (const field of PRUNABLE_ARG_FIELDS) {
    const value = args[field];
    if (typeof value === "string" && value.length > head) {
      args[field] =
        value.slice(0, head) +
        `\n… [older ${field} trimmed to save context: ${value.length} chars total; ` +
        "this change is already applied on disk \u2014 use read_file for the current state]";
      trimmed = true;
    }
  }
  return trimmed ? JSON.stringify(args) : null;
}

/**
 * Index from which EVERYTHING is preserved: the start of the last `keepTurns`
 * turns (a turn starts at a user message). User messages that start with
 * SUMMARY_MARKER do not count as a turn. Returns 0 if there are fewer turns.
 */
export function protectBoundary(messages: ChatMessage[], keepTurns: number): number {
  if (keepTurns <= 0) return messages.length;
  let seen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "user") {
      const content = m.content;
      if (typeof content === "string" && content.startsWith(SUMMARY_MARKER)) {
        continue; // compaction summary is not a user turn
      }
      seen += 1;
      if (seen >= keepTurns) return i;
    }
  }
  return 0;
}

/**
 * Returns a copy of the messages with old tool results trimmed.
 * Policy: last `keepTurns` turns intact; before them, the most recent
 * items preserved up to `toolOutputProtectTokens`; only trims if the total gain
 * reaches `toolOutputPruneMinimum`, otherwise returns the SAME reference.
 */
export function packMessages(messages: ChatMessage[], keepTurns?: number | null): ChatMessage[] {
  if (!config.packContext) return messages;

  const head = config.toolOutputStubHead;
  const protectTokens = config.toolOutputProtectTokens;
  const pruneMinimum = config.toolOutputPruneMinimum;
  const turns = keepTurns ?? config.toolOutputKeepTurns;

  // never trim content that would not actually end up smaller than the stub (guards
  // against bad config, e.g.: stub_head >= stub_threshold)
  const stubLen = head + STUB_OVERHEAD;
  const minPrunable = Math.max(config.toolOutputStubThreshold, stubLen);

  const boundary = protectBoundary(messages, turns);

  // scan from newest to oldest; budget shared between
  // tool outputs and write arguments
  let protectedTokens = 0;
  let reclaim = 0;
  const toPrune = new Set<number>(); // indices of tool messages to trim
  const toPruneArgs = new Map<number, Set<number>>(); // assistant idx -> tool_calls indices

  const keepInBudget = (size: number): boolean => {
    if (protectedTokens < protectTokens) {
      protectedTokens += Math.floor(size / 4);
      return true;
    }
    return false;
  };

  for (let i = boundary - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "tool") {
      const content = m.content;
      if (
        typeof content === "string" &&
        content.length > minPrunable &&
        !keepInBudget(content.length)
      ) {
        toPrune.add(i);
        reclaim += Math.floor((content.length - stubLen) / 4); // real gain
      }
    } else if (m.role === "assistant") {
      const calls = m.tool_calls ?? [];
      for (let j = calls.length - 1; j >= 0; j--) {
        const fn: Partial<ToolCallFunction> = calls[j]!.function ?? {};
        const args = fn.arguments;
        if (
          PRUNABLE_ARG_TOOLS.has(fn.name as string) &&
          typeof args === "string" &&
          args.length > minPrunable &&
          !keepInBudget(args.length)
        ) {
          let set = toPruneArgs.get(i);
          if (!set) {
            set = new Set<number>();
            toPruneArgs.set(i, set);
          }
          set.add(j);
          reclaim += Math.floor((args.length - stubLen) / 4);
        }
      }
    }
  }

  if ((toPrune.size === 0 && toPruneArgs.size === 0) || reclaim < pruneMinimum) {
    // nothing to trim, or gain too small: return the SAME object
    return messages;
  }

  const out: ChatMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    const argIdx = toPruneArgs.get(i);
    if (toPrune.has(i)) {
      out.push({ ...m, content: stubToolContent(m.content as string, head) });
    } else if (argIdx) {
      const calls: ToolCall[] = [];
      const original = m.tool_calls as ToolCall[];
      for (let j = 0; j < original.length; j++) {
        let tc = original[j]!;
        if (argIdx.has(j)) {
          const fn = tc.function;
          const stubbed = stubCallArguments(fn.arguments, head);
          if (stubbed !== null) {
            tc = { ...tc, function: { ...fn, arguments: stubbed } };
          }
        }
        calls.push(tc);
      }
      out.push({ ...m, tool_calls: calls });
    } else {
      out.push(m);
    }
  }
  return out;
}

/**
 * Copy with EVERY tool output and EVERY write argument cut at
 * `maxChars` (not just the old ones). Used exclusively to build the input
 * of the compaction summary.
 */
export function truncateToolOutputs(messages: ChatMessage[], maxChars: number): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    const content = m.content;
    if (m.role === "tool" && typeof content === "string" && content.length > maxChars) {
      out.push({
        ...m,
        content:
          content.slice(0, maxChars) +
          `\n[tool output truncated for summary: ${content.length} chars]`,
      });
    } else if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
      const calls: ToolCall[] = [];
      for (let tc of m.tool_calls) {
        const fn: Partial<ToolCallFunction> = tc.function ?? {};
        const args = fn.arguments;
        if (
          PRUNABLE_ARG_TOOLS.has(fn.name as string) &&
          typeof args === "string" &&
          args.length > maxChars
        ) {
          const stubbed = stubCallArguments(args, maxChars);
          if (stubbed !== null) {
            tc = { ...tc, function: { ...tc.function, arguments: stubbed } };
          }
        }
        calls.push(tc);
      }
      out.push({ ...m, tool_calls: calls });
    } else {
      out.push(m);
    }
  }
  return out;
}

/**
 * Rough token estimate (~4 chars/token), fallback when the provider
 * does not return usage in the stream. Port note: uses JSON.stringify instead of
 * Python's repr; values close, not identical (the thresholds absorb it).
 */
export function estimateTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const m of messages) total += JSON.stringify(m).length;
  return Math.ceil(total / 4);
}
