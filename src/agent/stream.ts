/**
 * Streaming completion consumption + mid-stream shapes.
 * Freeze tool schemas at the start of each sample (Codex StepContext pattern).
 */

import { estimateTokens, packMessages } from "../context.js";
import { ContentFilterError, StreamTruncatedError } from "../llm/errors.js";
import { chat } from "../llm/client.js";
import { getLogger } from "../logs.js";
import { activeSchemas } from "../tools/index.js";
import type { ChatMessage, Usage } from "../types.js";

const log = getLogger("agent.stream");

export interface UsageLike {
  prompt_tokens: number;
  completion_tokens: number;
  prompt_tokens_details?: { cached_tokens?: number } | null;
}

interface ToolCallDeltaLike {
  index: number;
  id?: string | null;
  function?: { name?: string | null; arguments?: string | null } | null;
}

interface DeltaLike {
  content?: string | null;
  tool_calls?: ToolCallDeltaLike[] | null;
}

interface ChoiceLike {
  delta?: DeltaLike | null;
  finish_reason?: string | null;
}

interface StreamChunkLike {
  usage?: UsageLike | null;
  choices?: ChoiceLike[];
}

/** Internal representation of a tool call accumulated from the stream. */
export interface StreamToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** Result of consuming the stream (mirrors the Python tuple). */
export interface StreamResult {
  content: string;
  toolCalls: StreamToolCall[];
  usage: UsageLike | null;
  finishReason: string | null;
}

/**
 * Consumes the streaming response; returns content, toolCalls, usage, finishReason.
 * `onToolReady` fires when a prior tool_call index is sealed (next index starts or
 * stream ends) — enables StreamingToolExecutor mid-stream starts.
 */
export async function streamCompletion(
  messages: ChatMessage[],
  onToken: (text: string) => void,
  schemas?: object[],
  onToolReady?: (tc: StreamToolCall) => void,
): Promise<StreamResult> {
  const frozenSchemas = schemas ?? activeSchemas();
  const stream = (await chat(
    packMessages(messages),
    frozenSchemas,
    true,
  )) as unknown as AsyncIterable<StreamChunkLike>;
  let content = "";
  const calls = new Map<number, StreamToolCall>();
  const ready = new Set<number>();
  let usage: UsageLike | null = null;
  let finishReason: string | null = null;
  let maxIndex = -1;

  const sealPrior = (upToExclusive: number): void => {
    if (!onToolReady) return;
    for (const [idx, tc] of calls) {
      if (idx < upToExclusive && !ready.has(idx) && tc.id && tc.name) {
        try {
          JSON.parse(tc.arguments || "{}");
          ready.add(idx);
          onToolReady({ ...tc });
        } catch {
          // args still streaming
        }
      }
    }
  };

  for await (const chunk of stream) {
    if (chunk.usage) usage = chunk.usage;
    if (!chunk.choices || chunk.choices.length === 0) continue;
    const choice = chunk.choices[0]!;
    const fr = choice.finish_reason;
    if (fr) finishReason = fr;
    const delta = choice.delta;
    if (delta === null || delta === undefined) continue;
    if (delta.content) {
      content += delta.content;
      onToken(delta.content);
    }
    if (delta.tool_calls) {
      for (const d of delta.tool_calls) {
        if (d.index > maxIndex) {
          sealPrior(d.index);
          maxIndex = d.index;
        }
        let acc = calls.get(d.index);
        if (!acc) {
          acc = { id: "", name: "", arguments: "" };
          calls.set(d.index, acc);
        }
        if (d.id) acc.id = d.id;
        if (d.function && d.function.name) acc.name += d.function.name;
        if (d.function && d.function.arguments) acc.arguments += d.function.arguments;
      }
    }
  }
  sealPrior(Number.POSITIVE_INFINITY);

  if (finishReason === "content_filter") {
    throw new ContentFilterError("response blocked by provider content filter");
  }
  if (finishReason === null && usage === null) {
    throw new StreamTruncatedError("stream ended without finish_reason");
  }
  let toolCalls = [...calls.keys()].sort((a, b) => a - b).map((i) => calls.get(i)!);
  if (finishReason === "length" && toolCalls.length > 0) {
    const valid: StreamToolCall[] = [];
    for (const tc of toolCalls) {
      try {
        JSON.parse(tc.arguments);
        valid.push(tc);
      } catch {
        log.warning("dropping truncated tool call %s (finish_reason=length)", tc.name);
      }
    }
    toolCalls = valid;
  }
  return { content, toolCalls, usage, finishReason };
}

/** Accumulates session usage tokens (includes prefix cache, defensive). */
export function trackUsage(usageStore: Usage, usage: UsageLike | null, messages: ChatMessage[]): void {
  const u = usageStore;
  if (usage !== null && usage !== undefined) {
    u.prompt_tokens = (u.prompt_tokens ?? 0) + usage.prompt_tokens;
    u.completion_tokens = (u.completion_tokens ?? 0) + usage.completion_tokens;
    u.last_prompt_tokens = usage.prompt_tokens;
    const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
    if (cached) {
      u.cached_prompt_tokens = (u.cached_prompt_tokens ?? 0) + cached;
    }
  } else {
    u.last_prompt_tokens = estimateTokens(packMessages(messages));
  }
}
