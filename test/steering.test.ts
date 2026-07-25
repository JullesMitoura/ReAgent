// Mirror of tests/test_steering.py, except test_steer_endpoint_404 (depends on the
// server, ported in the server phase). Steering (user messages in the middle of
// the turn) reads the current TurnContext's queue: where Python used
// agent.steer_queue, here a newTurnContext({steerQueue}) inside runWithTurn.
// monkeypatched _stream_completion becomes vi.spyOn(agent, "streamCompletion").

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// build_system_prompt -> "sys": keeps the constructor hermetic (without reading the real USER.md).
vi.mock("../src/system-prompt.js", () => ({ buildSystemPrompt: () => "sys" }));

import { Agent } from "../src/agent.js";
import { config } from "../src/config.js";
import { Session } from "../src/session.js";
import { newTurnContext, runWithTurn } from "../src/turn-context.js";
import type { ServerEvent } from "../src/types.js";

function failEmit(): void {
  throw new Error("emit should not be called");
}

const originalRoot = config.root;
let project: string;

beforeEach(() => {
  project = config.setRoot(fs.mkdtempSync(path.join(os.tmpdir(), "reagent-steer-")));
  config.autoApprove = true;
  config.contextFile = false;
});

afterEach(() => {
  config.setRoot(originalRoot);
  fs.rmSync(project, { recursive: true, force: true });
});

describe("steering", () => {
  it("test_drain_appends_user_message_and_emits_status", () => {
    const agent = new Agent(new Session({ id: "steer-1" }));
    const ctx = newTurnContext({ steerQueue: ["mensagem no meio do turno"] });

    const events: ServerEvent[] = [];
    runWithTurn(ctx, () => agent.drainSteering((ev) => events.push(ev)));

    expect(agent.messages[agent.messages.length - 1]).toEqual({
      role: "user",
      content: "mensagem no meio do turno",
    });
    const statuses = events.filter((e) => e.type === "status");
    expect(statuses.length).toBe(1);
    expect((statuses[0] as { text: string }).text).toContain("mid-turn");
    expect(ctx.steerQueue.length).toBe(0);
  });

  it("test_drain_multiple_messages_in_order", () => {
    const agent = new Agent(new Session({ id: "steer-2" }));
    const ctx = newTurnContext({ steerQueue: ["primeira", "segunda"] });

    const events: ServerEvent[] = [];
    runWithTurn(ctx, () => agent.drainSteering((ev) => events.push(ev)));

    const users = agent.messages.filter((m) => m.role === "user").map((m) => m.content);
    expect(users).toEqual(["primeira", "segunda"]);
    expect(events.filter((e) => e.type === "status").length).toBe(2);
  });

  it("test_drain_without_queue_is_noop", () => {
    const agent = new Agent(new Session({ id: "steer-3" }));
    const before = [...agent.messages];
    agent.drainSteering(failEmit); // no current TurnContext (equivalent to steer_queue None in the CLI)
    expect(agent.messages).toEqual(before);
  });

  it("test_drain_with_empty_queue_is_noop", () => {
    const agent = new Agent(new Session({ id: "steer-4" }));
    const ctx = newTurnContext({ steerQueue: [] });
    const before = [...agent.messages];
    runWithTurn(ctx, () => agent.drainSteering(failEmit));
    expect(agent.messages).toEqual(before);
  });

  it("test_final_round_resamples_on_pending_steer", async () => {
    // A message that arrives DURING the final stream triggers a new sampling round
    // instead of the turn ending with it lost in the queue.
    const agent = new Agent(new Session({ id: "steer-5" }));
    const ctx = newTurnContext({ steerQueue: [] });

    let n = 0;
    vi.spyOn(agent, "streamCompletion").mockImplementation(async () => {
      n += 1;
      if (n === 1) {
        ctx.steerQueue.push("steered mid-final"); // arrives while the final response streams
        return { content: "primeira", toolCalls: [], usage: null, finishReason: "stop" };
      }
      return { content: "segunda", toolCalls: [], usage: null, finishReason: "stop" };
    });

    const result = await runWithTurn(ctx, () => agent.runEvents("go", () => {}));

    expect(n).toBe(2);
    expect(result).toBe("segunda");
    // the steered message entered as user between the assistant "primeira" and "segunda"
    const pairs = agent.messages.map((m) => [m.role, m.content ?? null] as const);
    const idx = pairs.findIndex((p) => p[0] === "user" && p[1] === "steered mid-final");
    expect(pairs[idx - 1]).toEqual(["assistant", "primeira"]);
    expect(pairs[pairs.length - 1]).toEqual(["assistant", "segunda"]);
  });

  it("test_finally_drains_on_error", async () => {
    // Fatal error in the stream: the pending steered message is not lost; the
    // finally drains it into the history before the save.
    const agent = new Agent(new Session({ id: "steer-6" }));
    const ctx = newTurnContext({ steerQueue: [] });

    class Fatal extends Error {}
    vi.spyOn(agent, "streamCompletion").mockImplementation(async () => {
      ctx.steerQueue.push("late message");
      throw new Fatal("boom");
    });

    await expect(runWithTurn(ctx, () => agent.runEvents("go", () => {}))).rejects.toThrow(Fatal);

    const hasLate = agent.messages.some(
      (m) => m.role === "user" && m.content === "late message",
    );
    expect(hasLate).toBe(true);
    const reloaded = Session.load(agent.session.id); // and it stayed in the saved session
    expect(reloaded.messages.some((m) => m.role === "user" && m.content === "late message")).toBe(
      true,
    );
  });
});
