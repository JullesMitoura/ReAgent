// Max-output recovery: finish_reason=length with no tool calls must auto-
// continue (Claude Code pattern) instead of ending the turn mid-thought.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MAX_OUTPUT_RECOVERIES, STATUS_MAX_OUTPUT_CONTINUE } from "../src/agent/status.js";
import { runQueryLoop, type QueryLoopHost } from "../src/agent/query.js";
import { config } from "../src/config.js";
import { Session } from "../src/session.js";
import type { ServerEvent } from "../src/types.js";

const originalRoot = config.root;
let project: string;

beforeEach(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), "reagent-maxout-"));
  config.setRoot(project);
});

afterEach(() => {
  config.setRoot(originalRoot);
  fs.rmSync(project, { recursive: true, force: true });
});

describe("query loop max-output recovery", () => {
  it("continues after truncated completion and finishes on stop", async () => {
    const session = Session.new();
    session.messages = [{ role: "system", content: "sys" }];
    let round = 0;
    const host: QueryLoopHost = {
      session,
      messages: session.messages,
      streamCompletion: async () => {
        round += 1;
        if (round === 1) {
          return {
            content: "partial answer that was cut off mid-",
            toolCalls: [],
            usage: null,
            finishReason: "length",
          };
        }
        return {
          content: "sentence. Here is the rest.",
          toolCalls: [],
          usage: null,
          finishReason: "stop",
        };
      },
      dispatchParallel: async () => ({}),
      drainSteering: () => 0,
      compact: async () => {},
    };

    const events: ServerEvent[] = [];
    const final = await runQueryLoop(host, "go", (ev) => events.push(ev));
    // Assembled across recovery rounds (not just the last segment).
    expect(final).toContain("partial answer that was cut off mid-");
    expect(final).toContain("Here is the rest");
    expect(round).toBe(2);
    const statuses = events.filter((e) => e.type === "status").map((e) => e.text);
    expect(statuses).toContain(STATUS_MAX_OUTPUT_CONTINUE(1, MAX_OUTPUT_RECOVERIES));
    // Recovery nudge must have been injected as a user message.
    expect(
      session.messages.some(
        (m) =>
          m.role === "user" &&
          typeof m.content === "string" &&
          m.content.includes("truncated by the output token limit"),
      ),
    ).toBe(true);
  });

  it("stops recovering after MAX_OUTPUT_RECOVERIES truncations", async () => {
    const session = Session.new();
    session.messages = [{ role: "system", content: "sys" }];
    let round = 0;
    const host: QueryLoopHost = {
      session,
      messages: session.messages,
      streamCompletion: async () => {
        round += 1;
        return {
          content: `chunk-${round}`,
          toolCalls: [],
          usage: null,
          finishReason: "length",
        };
      },
      dispatchParallel: async () => ({}),
      drainSteering: () => 0,
      compact: async () => {},
    };

    const events: ServerEvent[] = [];
    const final = await runQueryLoop(host, "go", (ev) => events.push(ev));
    expect(round).toBe(MAX_OUTPUT_RECOVERIES + 1);
    expect(final).toContain(`chunk-${MAX_OUTPUT_RECOVERIES + 1}`);
    const continues = events.filter(
      (e) => e.type === "status" && e.text.startsWith("response truncated by token limit; continuing"),
    );
    expect(continues).toHaveLength(MAX_OUTPUT_RECOVERIES);
  });
});
