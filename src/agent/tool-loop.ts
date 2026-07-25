/**
 * Shared non-streaming tool loop for explore / plan / worker / general-purpose
 * sub-agents. Main agent uses the streaming path in query-engine.ts.
 *
 * Keeps nested agents on the same chat → tools → continue machinery without
 * importing the streaming Agent class (avoids cycles with tools/*).
 */

import { packMessages } from "../context.js";
import { DoomLoopDetector, doomLoopMessage, doomLoopWorkerMessage } from "../lib/doom-loop.js";
import { chat } from "../llm/client.js";
import { reminderMessageForRound } from "../prompts/reminders/inject.js";
import type { ChatMessage, ToolCall } from "../types.js";
import { dispatch } from "../tools/index.js";
import { runToolBatches } from "../tools/orchestration.js";
import { cancelSignal, currentTurn } from "../turn-context.js";

export interface ToolLoopOptions {
  /** System + user messages (mutated in place). */
  messages: ChatMessage[];
  /** Frozen schemas for every sample in this loop. */
  schemas: object[];
  /** Max model rounds before forced summary. */
  maxSteps: number;
  /** Allowed tool names; anything else is refused. */
  allowedTools: ReadonlySet<string>;
  /** Message when step budget is exhausted (no tools). */
  forceSummary: string;
  /** Fallback text when the model returns empty content. */
  emptyResult?: string;
  /** Doom-loop style: "main" | "worker" | "none". */
  doomStyle?: "main" | "worker" | "none";
  /** Called before each tool dispatch (e.g. agent_update). */
  onToolStart?: (name: string, argumentsJson: string) => void;
  /** Called after each tool dispatch with its result (e.g. to detect denials). */
  onToolEnd?: (name: string, result: string) => void;
  /** Abort check between steps (cooperative cancel). */
  shouldAbort?: () => boolean;
  /** Custom refusal message for disallowed tools. */
  refuseMessage?: (name: string) => string;
}

interface CompletionToolCall {
  id: string;
  function: { name: string; arguments: string };
}
interface CompletionMessage {
  content?: string | null;
  tool_calls?: CompletionToolCall[] | null;
}
interface CompletionResponse {
  choices: { message: CompletionMessage }[];
}

/** Converts a completion message into a history ChatMessage. */
export function assistantMessage(msg: CompletionMessage): ChatMessage {
  const out: ChatMessage = { role: "assistant", content: msg.content || "" };
  const toolCalls = msg.tool_calls;
  if (toolCalls && toolCalls.length > 0) {
    out.tool_calls = toolCalls.map<ToolCall>((tc) => ({
      id: tc.id,
      type: "function",
      function: { name: tc.function.name, arguments: tc.function.arguments },
    }));
  }
  return out;
}

/**
 * Runs a bounded non-streaming agentic loop; returns the final text report.
 * Concurrency-safe tools in a round run via runToolBatches (Claude Code pattern).
 */
export async function runToolLoop(opts: ToolLoopOptions): Promise<string> {
  const empty = opts.emptyResult ?? "(no findings)";
  const doomStyle = opts.doomStyle ?? "none";
  const doom = doomStyle === "none" ? null : new DoomLoopDetector();

  for (let step = 0; step < opts.maxSteps; step++) {
    if (opts.shouldAbort?.()) return "(cancelled: the turn was interrupted)";
    const { signal, dispose } = cancelSignal(currentTurn());
    let resp: CompletionResponse;
    try {
      resp = (await chat(
        packMessages(opts.messages, 0),
        opts.schemas,
        false,
        signal,
      )) as unknown as CompletionResponse;
    } finally {
      dispose();
    }
    const msg = resp.choices[0]!.message;
    opts.messages.push(assistantMessage(msg));
    const toolCalls = msg.tool_calls || [];
    if (toolCalls.length === 0) {
      return msg.content || empty;
    }

    const ordered: ToolCall[] = toolCalls.map((tc) => ({
      id: tc.id,
      type: "function" as const,
      function: { name: tc.function.name, arguments: tc.function.arguments },
    }));

    const precomputed: Record<string, string> = {};
    const toRun: ToolCall[] = [];

    for (const tc of ordered) {
      const name = tc.function.name;
      opts.onToolStart?.(name, tc.function.arguments);
      if (doom && doom.record(name, tc.function.arguments)) {
        precomputed[tc.id] =
          doomStyle === "worker" ? doomLoopWorkerMessage(name) : doomLoopMessage(name);
      } else if (!opts.allowedTools.has(name)) {
        precomputed[tc.id] =
          opts.refuseMessage?.(name) ??
          `Error: this agent may not use tool '${name}'`;
      } else {
        toRun.push(tc);
      }
    }

    if (toRun.length > 0) {
      const batch = await runToolBatches(toRun);
      Object.assign(precomputed, batch);
    }

    const roundResults: Array<{ name: string; result: string }> = [];
    for (const tc of ordered) {
      const result = precomputed[tc.id] ?? `Error: missing result for ${tc.function.name}`;
      opts.onToolEnd?.(tc.function.name, result);
      opts.messages.push({ role: "tool", tool_call_id: tc.id, content: result });
      roundResults.push({ name: tc.function.name, result });
    }
    // structured_output is terminal: the sub-agent has signaled its final result,
    // so return that machine-readable payload instead of running another round.
    const terminal = [...ordered]
      .reverse()
      .find(
        (tc) =>
          tc.function.name === "structured_output" &&
          typeof precomputed[tc.id] === "string" &&
          !precomputed[tc.id]!.startsWith("Error"),
      );
    if (terminal) return precomputed[terminal.id]!;
    const reminder = reminderMessageForRound(roundResults);
    if (reminder) opts.messages.push(reminder);
  }

  opts.messages.push({ role: "user", content: opts.forceSummary });
  const { signal: finalSignal, dispose: disposeFinal } = cancelSignal(currentTurn());
  let resp: CompletionResponse;
  try {
    resp = (await chat(
      packMessages(opts.messages, 0),
      null,
      false,
      finalSignal,
    )) as unknown as CompletionResponse;
  } finally {
    disposeFinal();
  }
  return resp.choices[0]!.message.content || empty;
}
