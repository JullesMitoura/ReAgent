/**
 * Streaming tool executor (Claude Code StreamingToolExecutor pattern).
 *
 * Starts concurrency-safe tools as soon as a complete tool_call is available
 * during stream accumulation; drains results in original call order.
 */

import type { EmitFn, ToolCall } from "../types.js";
import { dispatch } from "./index.js";
import { isCallConcurrencySafe } from "./orchestration.js";

export interface PendingToolCall {
  id: string;
  name: string;
  arguments: string;
}

interface Inflight {
  id: string;
  promise: Promise<string>;
  result?: string;
  done: boolean;
}

/**
 * Starts tools early when safe; waits for prior exclusive tools before starting
 * a non-safe one. Results are retrieved in call order via drainOrdered().
 */
export class StreamingToolExecutor {
  private queue: Inflight[] = [];
  private exclusiveBusy: Promise<void> = Promise.resolve();
  private emit: EmitFn | null;

  constructor(emit: EmitFn | null = null) {
    this.emit = emit;
  }

  /** Enqueue a completed tool call (may start immediately if concurrency-safe). */
  add(tc: PendingToolCall): void {
    const start = async (): Promise<string> => {
      this.emit?.({
        type: "tool_start",
        id: tc.id,
        name: tc.name,
        args: tc.arguments.slice(0, 200),
      });
      return dispatch(tc.name, tc.arguments);
    };

    if (isCallConcurrencySafe(tc.name, tc.arguments)) {
      const inflight: Inflight = { id: tc.id, promise: start(), done: false };
      inflight.promise.then(
        (r) => {
          inflight.result = r;
          inflight.done = true;
        },
        (e) => {
          inflight.result = `Unexpected error: ${e instanceof Error ? e.message : String(e)}`;
          inflight.done = true;
        },
      );
      this.queue.push(inflight);
      return;
    }

    // Exclusive: chain after previous exclusive work (and wait for prior safes to settle).
    const run = this.exclusiveBusy.then(async () => {
      // Wait for previously queued safe tools so history order stays coherent
      // when we interleave — we still store by id and drain in order.
      return start();
    });
    this.exclusiveBusy = run.then(
      () => undefined,
      () => undefined,
    );
    const inflight: Inflight = { id: tc.id, promise: run, done: false };
    inflight.promise.then(
      (r) => {
        inflight.result = r;
        inflight.done = true;
      },
      (e) => {
        inflight.result = `Unexpected error: ${e instanceof Error ? e.message : String(e)}`;
        inflight.done = true;
      },
    );
    this.queue.push(inflight);
  }

  /** Wait for all queued tools; return {id: result} in original order. */
  async drainOrdered(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const item of this.queue) {
      const result = item.result ?? (await item.promise);
      out[item.id] = result;
      this.emit?.({ type: "tool_end", id: item.id, result: result.slice(0, 3000) });
    }
    return out;
  }

  get size(): number {
    return this.queue.length;
  }
}

/** Convert stream tool calls into ToolCall wire shape. */
export function toToolCalls(pending: PendingToolCall[]): ToolCall[] {
  return pending.map((tc) => ({
    id: tc.id,
    type: "function",
    function: { name: tc.name, arguments: tc.arguments },
  }));
}
