// Regression tests for cancelSignal: the bridge from the turn's cooperative
// `cancel.set` flag to a real AbortSignal, added so a blocking LLM call can be
// aborted promptly (see src/agent/stream.ts, tool-loop.ts, compact.ts) instead
// of only being noticed between rounds, once per streamed token/tool call at
// best (and never, for a single non-streaming call or a stalled connection).

import { describe, expect, it } from "vitest";

import { cancelSignal, newTurnContext } from "../src/turn-context.js";

describe("cancelSignal", () => {
  it("test_no_turn_returns_a_live_signal", () => {
    const { signal, dispose } = cancelSignal(undefined);
    expect(signal.aborted).toBe(false);
    dispose(); // no-op, must not throw
  });

  it("test_already_cancelled_turn_returns_an_already_aborted_signal", () => {
    const ctx = newTurnContext({ cancel: { set: true } });
    const { signal, dispose } = cancelSignal(ctx);
    expect(signal.aborted).toBe(true);
    dispose();
  });

  it("test_setting_cancel_later_aborts_the_signal_promptly", async () => {
    const ctx = newTurnContext();
    const { signal, dispose } = cancelSignal(ctx);
    try {
      expect(signal.aborted).toBe(false);
      ctx.cancel.set = true;
      // the poll interval is short (100ms); give it a couple of ticks
      await new Promise((r) => setTimeout(r, 150));
      expect(signal.aborted).toBe(true);
    } finally {
      dispose();
    }
  });

  it("test_dispose_stops_polling_so_a_later_cancel_has_no_effect", async () => {
    const ctx = newTurnContext();
    const { signal, dispose } = cancelSignal(ctx);
    dispose();
    ctx.cancel.set = true;
    await new Promise((r) => setTimeout(r, 150));
    expect(signal.aborted).toBe(false);
  });
});
