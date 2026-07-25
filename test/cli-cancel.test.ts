// Regression test for the CLI/REPL cancellation gap found during the
// architecture audit: Ctrl+C used to reject runTurnCancelable's own promise
// (via the `cancelled` race) without ever stopping the agent loop itself, so
// the underlying turn kept calling the LLM/tools detached from the REPL that
// had already moved on and printed "Turn interrupted.". The fix threads the
// same `cancel` flag into the TurnContext and makes agent-render's emit throw
// TurnCancelled once it is set, mirroring how the server's RunningTurn works.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/system-prompt.js", () => ({ buildSystemPrompt: () => "sys" }));

const hooks = vi.hoisted(() => ({
  chatCalls: 0,
  dispatchCalls: 0,
  onDispatch: null as null | (() => void),
}));

// Every round hands back one write_file tool call with distinct arguments (a
// counter in the content), so the doom-loop breaker never kicks in and an
// uncancelled loop would keep going for many rounds (up to
// config.maxIterations) instead of stopping right after cancellation.
vi.mock("../src/llm/client.js", () => ({
  chat: () => {
    hooks.chatCalls += 1;
    const tc = {
      index: 0,
      id: `c${hooks.chatCalls}`,
      function: {
        name: "write_file",
        arguments: JSON.stringify({ path: "x.txt", content: `hi ${hooks.chatCalls}` }),
      },
    };
    return [
      { choices: [{ delta: { content: null, tool_calls: [tc] }, finish_reason: null }], usage: null },
      {
        choices: [{ delta: { content: null, tool_calls: null }, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      },
    ];
  },
  getClient: () => {
    throw new Error("no llm client in tests");
  },
}));

vi.mock("../src/tools/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/tools/index.js")>();
  return {
    ...actual,
    dispatch: (name: string, args: string) => {
      hooks.dispatchCalls += 1;
      hooks.onDispatch?.();
      return actual.dispatch(name, args);
    },
  };
});

import { Agent, TurnCancelled } from "../src/agent.js";
import { ChangeTracker } from "../src/changes.js";
import { runTurnCancelable } from "../src/cli/repl.js";
import { config } from "../src/config.js";
import * as shell from "../src/tools/shell.js";

const originalRoot = config.root;
let project: string;

beforeEach(() => {
  project = config.setRoot(fs.mkdtempSync(path.join(os.tmpdir(), "reagent-cli-cancel-")));
  config.autoApprove = true;
  config.contextFile = false;
  hooks.chatCalls = 0;
  hooks.dispatchCalls = 0;
  hooks.onDispatch = null;
});

afterEach(() => {
  config.setRoot(originalRoot);
  fs.rmSync(project, { recursive: true, force: true });
});

function fakeOut(): NodeJS.WriteStream {
  return { isTTY: false, write: () => true } as unknown as NodeJS.WriteStream;
}

describe("cli cancellation", () => {
  it("test_ctrl_c_stops_the_agent_loop_instead_of_running_detached", async () => {
    vi.spyOn(shell, "killActive").mockReturnValue(0);
    const agent = new Agent();
    const changes = new ChangeTracker();

    let onCancel: (() => void) | null = null;
    // Simulate Ctrl+C firing right as the 2nd tool call is dispatched.
    hooks.onDispatch = () => {
      if (hooks.dispatchCalls === 2) onCancel?.();
    };

    await expect(
      runTurnCancelable(agent, "do it", changes, fakeOut(), (cb) => {
        onCancel = cb;
        return () => {};
      }),
    ).rejects.toBeInstanceOf(TurnCancelled);

    const dispatchesAtCancel = hooks.dispatchCalls;
    expect(dispatchesAtCancel).toBe(2);

    // Give any detached continuation a chance to run before asserting it
    // didn't: without the fix this reliably grows well past 2 (the mocked
    // chat/dispatch calls are synchronous, so an uncancelled loop races
    // through most of its iteration budget within a tick).
    await new Promise((r) => setTimeout(r, 20));
    expect(hooks.dispatchCalls).toBe(dispatchesAtCancel);
  });
});
