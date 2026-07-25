// Regression test for the doom-loop breaker in the main query loop: a
// concurrency-safe but non-idempotent call (agent with background=true,
// which really spawns a sub-agent) used to always dispatch, only swapping the
// text for the doom-loop message afterward — so 3+ identical calls in a row
// still spawned a sub-agent every single time. The fix (src/agent/query.ts,
// checkAgentDoom) records+decides BEFORE the early/parallel dispatch path
// adds the call to its batch, so a tripped call is never dispatched at all.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  dispatchCalls: [] as string[],
}));

vi.mock("../src/tools/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/tools/index.js")>();
  return {
    ...actual,
    dispatch: (name: string, args: string) => {
      if (name === "agent") hooks.dispatchCalls.push(args);
      return Promise.resolve("ack: agent launched in background (id abc123)");
    },
  };
});

import { config } from "../src/config.js";
import { runQueryLoop, type QueryLoopHost } from "../src/agent/query.js";
import { Session } from "../src/session.js";
import type { StreamToolCall } from "../src/agent/stream.js";
import type { ServerEvent } from "../src/types.js";

const originalRoot = config.root;
let project: string;

beforeEach(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), "reagent-doomloop-"));
  config.setRoot(project);
  hooks.dispatchCalls = [];
});

afterEach(() => {
  config.setRoot(originalRoot);
  fs.rmSync(project, { recursive: true, force: true });
});

describe("query loop doom-loop breaker", () => {
  it("test_repeated_background_agent_call_stops_dispatching_after_two", async () => {
    const session = Session.new();
    session.messages = [{ role: "system", content: "sys" }];

    const BG_AGENT_ARGS = JSON.stringify({
      background: true,
      subagent_type: "general-purpose",
      prompt: "do the same thing",
    });

    let round = 0;
    const host: QueryLoopHost = {
      session,
      messages: session.messages,
      streamCompletion: async (_onToken, _schemas, onToolReady) => {
        round += 1;
        if (round > 4) {
          return { content: "all done", toolCalls: [], usage: null, finishReason: "stop" };
        }
        const tc: StreamToolCall = { id: `c${round}`, name: "agent", arguments: BG_AGENT_ARGS };
        onToolReady?.(tc);
        return { content: "", toolCalls: [tc], usage: null, finishReason: "tool_calls" };
      },
      dispatchParallel: async () => ({}),
      drainSteering: () => 0,
      compact: async () => {},
    };

    const events: ServerEvent[] = [];
    const final = await runQueryLoop(host, "go", (ev) => events.push(ev));

    expect(final).toBe("all done");
    // Rounds 1-2 dispatch for real; rounds 3-4 are identical repeats that must
    // be blocked BEFORE dispatch, not just have their text swapped afterward.
    expect(hooks.dispatchCalls).toHaveLength(2);

    const toolResults = session.messages.filter((m) => m.role === "tool").map((m) => String(m.content));
    expect(toolResults).toHaveLength(4);
    expect(toolResults[0]).toContain("ack: agent launched");
    expect(toolResults[1]).toContain("ack: agent launched");
    expect(toolResults[2]).toContain("repeated 3 times");
    expect(toolResults[3]).toContain("repeated 3 times");
  });
});
