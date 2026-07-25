/**
 * Core agentic query loop as an async generator (Claude Code query() pattern).
 * Yields ServerEvents; returns the final assistant text.
 *
 * QueryEngine / Agent own the session; this function is the turn loop only.
 */

import { config } from "../config.js";
import { estimateTokens, packMessages } from "../context.js";
import { DoomLoopDetector, doomLoopMessage } from "../lib/doom-loop.js";
import {
  ContentFilterError,
  ContextWindowExceededError,
  isContextLengthError,
  isRetryable,
  retryDelay,
  userMessage,
} from "../llm/errors.js";
import { getLogger, redact } from "../logs.js";
import { activeSchemas, dispatch } from "../tools/index.js";
import { isCallConcurrencySafe } from "../tools/orchestration.js";
import { StreamingToolExecutor } from "../tools/streaming-executor.js";
import { getTodos } from "../tools/todo.js";
import { runStopHooks } from "../hooks/runner.js";
import type { ChatMessage, EmitFn, ServerEvent, ToolCall } from "../types.js";
import type { Session } from "../session.js";

import { compactSession } from "./compact.js";
import { microcompactIfNeeded } from "./microcompact.js";
import {
  streamCompletion,
  trackUsage,
  type StreamToolCall,
  type UsageLike,
} from "./stream.js";
import {
  STATUS_COMPACTING,
  STATUS_CONTENT_FILTER,
  STATUS_CTX_EXCEEDED,
  STATUS_CTX_EXHAUSTED,
  STATUS_STEERED,
  STATUS_STREAM_PARTIAL,
  STATUS_STREAM_RETRY,
  STATUS_TRUNCATED,
  STREAM_RETRY_LIMIT,
  TOOL_ERROR_PREFIXES,
  _testHooks,
} from "./status.js";
import { reminderMessageForRound } from "../prompts/reminders/inject.js";

const log = getLogger("agent.query");

function drainBgNotifications(host: QueryLoopHost, emit: EmitFn): number {
  let drained = 0;
  const queue = host.session.pendingBgNotifications;
  while (queue.length > 0) {
    host.messages.push({ role: "user", content: queue.shift()! });
    drained += 1;
    emit({ type: "status", text: "Background agent result received" });
  }
  return drained;
}

function appendRoundReminders(
  host: QueryLoopHost,
  results: Array<{ name: string; result: string }>,
): void {
  const reminder = reminderMessageForRound(results);
  if (reminder) host.messages.push(reminder);
}

/**
 * Cheap microcompaction first (clears old tool results in place); the full
 * summarizing compaction only runs if the history is still over the threshold.
 */
async function compactIfOverThreshold(host: QueryLoopHost, emit: EmitFn): Promise<void> {
  microcompactIfNeeded(host.session);
  if (
    (host.session.usage.last_prompt_tokens ?? 0) > config.compactThreshold ||
    estimateTokens(packMessages(host.messages)) > config.compactThreshold
  ) {
    emit({ type: "status", text: STATUS_COMPACTING });
    await host.compact();
  }
}

export interface QueryLoopHost {
  session: Session;
  messages: ChatMessage[];
  /** Spyable stream hook (Agent.streamCompletion). */
  streamCompletion: (
    onToken: (text: string) => void,
    schemas?: object[],
    onToolReady?: (tc: StreamToolCall) => void,
  ) => Promise<{
    content: string;
    toolCalls: StreamToolCall[];
    usage: UsageLike | null;
    finishReason: string | null;
  }>;
  /** Spyable parallel dispatch (Agent.dispatchParallel). */
  dispatchParallel: (toolCalls: StreamToolCall[]) => Promise<Record<string, string>>;
  drainSteering: (emit: EmitFn) => number;
  compact: () => Promise<void>;
}

/**
 * Runs one user turn as an async generator of ServerEvents.
 * Final return value is the assistant text (via generator return).
 */
export async function* queryLoop(
  host: QueryLoopHost,
  _userInput: string,
  emit: EmitFn,
): AsyncGenerator<ServerEvent, string, undefined> {
  const wrapped: EmitFn = (ev) => {
    emit(ev);
  };
  const doomLoop = new DoomLoopDetector();
  let contextRetried = false;
  // Stop-hook death-spiral guard: at most 2 blocked completions per turn.
  let stopHookContinuations = 0;

  // Immediate feedback (CLI spinner / web thinking label) before first model tokens.
  wrapped({ type: "status", text: "Thinking…" });

  for (let iter = 0; iter < config.maxIterations; iter++) {
    host.drainSteering(wrapped);
    drainBgNotifications(host, wrapped);
    let attempts = 0;
    let content: string;
    let toolCalls: StreamToolCall[];
    let usage: UsageLike | null;
    let finishReason: string | null;
    const stepSchemas = activeSchemas();
    // Live emit: tool_start fires as each call becomes ready (mid-stream), tool_end on drain.
    const early = new StreamingToolExecutor(wrapped);
    const earlyIds = new Set<string>();

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const partial: string[] = [];
      const onToken = (text: string): void => {
        partial.push(text);
        wrapped({ type: "token", text });
      };
      try {
        const r = await host.streamCompletion(onToken, stepSchemas, (tc) => {
          if (isCallConcurrencySafe(tc.name, tc.arguments) && tc.id && !earlyIds.has(tc.id)) {
            earlyIds.add(tc.id);
            early.add(tc);
          }
        });
        content = r.content;
        toolCalls = r.toolCalls;
        usage = r.usage;
        finishReason = r.finishReason;
        break;
      } catch (exc) {
        const streamed = partial.join("");
        if (streamed.trim()) {
          host.messages.push({ role: "assistant", content: streamed });
        }
        if (exc instanceof ContentFilterError) {
          wrapped({ type: "status", text: STATUS_CONTENT_FILTER });
          throw exc;
        }
        if (isContextLengthError(exc)) {
          if (!contextRetried) {
            contextRetried = true;
            wrapped({ type: "status", text: STATUS_CTX_EXCEEDED });
            yield { type: "status", text: STATUS_CTX_EXCEEDED };
            await host.compact();
            continue;
          }
          host.session.usage.last_prompt_tokens = config.compactThreshold + 1;
          wrapped({ type: "status", text: STATUS_CTX_EXHAUSTED });
          throw new ContextWindowExceededError(userMessage(exc));
        }
        attempts += 1;
        if (attempts > STREAM_RETRY_LIMIT || !isRetryable(exc)) {
          log.warning(
            "stream failed after %d chars: %s",
            streamed.length,
            exc instanceof Error ? exc.constructor.name : typeof exc,
          );
          wrapped({ type: "status", text: STATUS_STREAM_PARTIAL });
          throw exc;
        }
        const delay = retryDelay(exc, attempts);
        wrapped({ type: "status", text: STATUS_STREAM_RETRY(Math.round(delay), attempts) });
        await _testHooks.sleep(delay * 1000);
      }
    }

    if (finishReason === "length") {
      wrapped({ type: "status", text: STATUS_TRUNCATED });
    }

    // Commit the assistant message before any further emits when tools are
    // present. Mid-stream early starts may have set cancel already; sanitize
    // needs tool_calls on the assistant to stub "aborted by user".
    const assistantMsg: ChatMessage = { role: "assistant", content };
    if (toolCalls.length > 0) {
      assistantMsg.tool_calls = toolCalls.map(
        (tc): ToolCall => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: tc.arguments },
        }),
      );
    }
    host.messages.push(assistantMsg);

    trackUsage(host.session.usage, usage, host.messages);
    const u = host.session.usage;
    wrapped({
      type: "usage",
      prompt_tokens: u.prompt_tokens,
      completion_tokens: u.completion_tokens,
      last_prompt_tokens: u.last_prompt_tokens,
      cached_prompt_tokens: u.cached_prompt_tokens ?? 0,
      context_window: config.contextWindowTokens,
    });

    if (toolCalls.length === 0) {
      if (host.drainSteering(wrapped)) {
        continue;
      }
      const final = content || "(empty response)";
      let stop: { block: boolean; reason?: string } = { block: false };
      try {
        stop = runStopHooks(final);
      } catch {
        // hooks must never break the turn
      }
      if (stop.block && stopHookContinuations < 2) {
        stopHookContinuations += 1;
        host.messages.push({
          role: "user",
          content:
            `<system-reminder>A Stop hook blocked completion: ${stop.reason || "(no reason given)"}. ` +
            "Address the feedback and finish the task; do not mention this reminder to the user.</system-reminder>",
        });
        wrapped({ type: "status", text: "Stop hook feedback — continuing" });
        continue;
      }
      wrapped({ type: "done", content: final });
      return final;
    }

    // Run tools with live tool_start → work → tool_end (not start+end after the fact).
    let precomputed: Record<string, string> = {};
    const allSafe =
      toolCalls.length > 1 &&
      toolCalls.every((tc) => isCallConcurrencySafe(tc.name, tc.arguments));
    let endsAlreadyEmitted = false;

    if (earlyIds.size > 0) {
      for (const tc of toolCalls) {
        if (!earlyIds.has(tc.id)) {
          early.add(tc);
        }
      }
      precomputed = await early.drainOrdered();
      endsAlreadyEmitted = true;
    } else if (allSafe) {
      for (const tc of toolCalls) {
        log.info("tool call: %s args=%s", tc.name, redact(tc.arguments));
        wrapped({
          type: "tool_start",
          id: tc.id,
          name: tc.name,
          args: tc.arguments.slice(0, 200),
        });
      }
      precomputed = await host.dispatchParallel(toolCalls);
    } else {
      // Sequential / mixed: start → run → end per tool so the UI stays live.
      const roundResults: Array<{ name: string; result: string }> = [];
      for (const tc of toolCalls) {
        log.info("tool call: %s args=%s", tc.name, redact(tc.arguments));
        wrapped({
          type: "tool_start",
          id: tc.id,
          name: tc.name,
          args: tc.arguments.slice(0, 200),
        });
        let result: string;
        if (doomLoop.record(tc.name, tc.arguments)) {
          log.warning("doom loop: %s repeated 3 times", tc.name);
          result = doomLoopMessage(tc.name);
        } else {
          result = await dispatch(tc.name, tc.arguments);
        }
        if (TOOL_ERROR_PREFIXES.some((p) => result.startsWith(p))) {
          log.warning("tool error: %s -> %s", tc.name, result.slice(0, 200));
        }
        if (tc.name === "todowrite" && !result.startsWith("Error")) {
          wrapped({ type: "todos", todos: getTodos() });
        }
        wrapped({ type: "tool_end", id: tc.id, result: result.slice(0, 3000) });
        host.messages.push({ role: "tool", tool_call_id: tc.id, content: result });
        roundResults.push({ name: tc.name, result });
      }
      appendRoundReminders(host, roundResults);
      host.session.todos = getTodos();
      host.session.save();
      wrapped({ type: "status", text: "Thinking…" });
      await compactIfOverThreshold(host, wrapped);
      continue;
    }

    const parallelRound: Array<{ name: string; result: string }> = [];
    for (const tc of toolCalls) {
      if (!(tc.id in precomputed)) {
        log.info("tool call: %s args=%s", tc.name, redact(tc.arguments));
      }
      let result: string;
      if (doomLoop.record(tc.name, tc.arguments)) {
        log.warning("doom loop: %s repeated 3 times", tc.name);
        result = doomLoopMessage(tc.name);
      } else {
        result = precomputed[tc.id] ?? (await dispatch(tc.name, tc.arguments));
      }
      if (TOOL_ERROR_PREFIXES.some((p) => result.startsWith(p))) {
        log.warning("tool error: %s -> %s", tc.name, result.slice(0, 200));
      }
      if (tc.name === "todowrite" && !result.startsWith("Error")) {
        wrapped({ type: "todos", todos: getTodos() });
      }
      if (!endsAlreadyEmitted) {
        wrapped({ type: "tool_end", id: tc.id, result: result.slice(0, 3000) });
      }
      host.messages.push({ role: "tool", tool_call_id: tc.id, content: result });
      parallelRound.push({ name: tc.name, result });
    }
    appendRoundReminders(host, parallelRound);

    host.session.todos = getTodos();
    host.session.save();
    wrapped({ type: "status", text: "Thinking…" });

    await compactIfOverThreshold(host, wrapped);
  }

  const final =
    `Reached the tool-iteration limit (${config.maxIterations} rounds) for this turn. ` +
    "Ask me to continue if the task is not finished.";
  wrapped({ type: "done", content: final });
  return final;
}

/** Consume queryLoop, forwarding yields to emit; return final text. */
export async function runQueryLoop(
  host: QueryLoopHost,
  userInput: string,
  emit: EmitFn,
): Promise<string> {
  const gen = queryLoop(host, userInput, emit);
  let step = await gen.next();
  while (!step.done) {
    // Events already forwarded via emit inside the loop; yields are informational.
    step = await gen.next();
  }
  return step.value;
}
