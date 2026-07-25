// Mirror of the LOOP/render tests in tests/test_agent_render.py that are NOT
// about the system prompt (those live in system-prompt.test.ts): iteration_limit,
// midturn_compaction, result_summary, is_failure_result, tool_round_saved.
//
// No network: Python's monkeypatch of src.llm.chat becomes a vi.mock of
// ../src/llm/client.js with synthetic STREAMING responses (iterable arrays,
// like Python's lists). build_system_prompt is shortened to "sys" (as in the
// midturn test's monkeypatch) to isolate the mid-turn compaction trigger from
// the pre-turn check. The `project` fixture becomes a beforeEach mkdtempSync.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// build_system_prompt -> "sys": keeps the history light and stable across turns
// (Python monkeypatches src.agent.build_system_prompt in the midturn test).
vi.mock("../src/system-prompt.js", () => ({ buildSystemPrompt: () => "sys" }));

// synthetic chat for agent.ts (which imports from the same resolved path).
vi.mock("../src/llm/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/llm/client.js")>();
  return { ...actual, chat: vi.fn(actual.chat) };
});

import { Agent, _testHooks, isFailureResult, resultSummary } from "../src/agent.js";
import { config } from "../src/config.js";
import { chat } from "../src/llm/client.js";
import { Session } from "../src/session.js";
import type { ServerEvent } from "../src/types.js";

// --- streaming fakes (shape consumed by streamCompletion) ---------------------
interface ToolCallDelta {
  index: number;
  id?: string;
  function: { name?: string; arguments?: string };
}
interface Delta {
  content?: string | null;
  tool_calls?: ToolCallDelta[] | null;
}
function deltaChunk(delta: Delta, finishReason: string | null = null): unknown {
  return { choices: [{ delta, finish_reason: finishReason }], usage: null };
}
function usageChunk(prompt = 10, completion = 3): unknown {
  return { choices: [], usage: { prompt_tokens: prompt, completion_tokens: completion } };
}

/** A streaming response with exactly one tool call and usage at the end. */
function oneToolCallStream(promptTokens: number): unknown[] {
  return [
    deltaChunk({
      content: null,
      tool_calls: [{ index: 0, id: "c0", function: { name: "list_dir", arguments: "{}" } }],
    }),
    usageChunk(promptTokens, 5),
  ];
}

/** A final response, without tool calls, that ends the turn. */
function finalTextStream(text: string): unknown[] {
  return [deltaChunk({ content: text, tool_calls: null }), usageChunk(10, 3)];
}

function freshAgent(): Agent {
  const s = Session.new();
  s.messages = [{ role: "system", content: "sys" }];
  return new Agent(s);
}

const originalRoot = config.root;
let project: string;

beforeEach(() => {
  project = config.setRoot(fs.mkdtempSync(path.join(os.tmpdir(), "reagent-render-")));
  config.autoApprove = true;
  config.contextFile = false;
  _testHooks.sleep = async () => {}; // never actually sleeps in tests
});

afterEach(() => {
  vi.mocked(chat).mockReset();
  config.setRoot(originalRoot);
  fs.rmSync(project, { recursive: true, force: true });
});

describe("agent-render", () => {
  // --- pure helpers -----------------------------------------------------------

  it("test_result_summary_first_nonempty_line_truncated", () => {
    expect(resultSummary("\n\n  hello world  \nsecond line")).toBe("hello world");
    expect(resultSummary("   \n\t  ")).toBe(""); // only spaces -> nothing to show

    const long = "x".repeat(300);
    const s = resultSummary(long, 120);
    expect(s.endsWith("…")).toBe(true);
    expect(s.length).toBeLessThanOrEqual(121); // ~120 + ellipsis
  });

  it("test_is_failure_result_flags_errors_and_denials", () => {
    expect(isFailureResult("Error: nope")).toBe(true);
    expect(isFailureResult("Unexpected error: Boom: x")).toBe(true);
    expect(isFailureResult("Argument error: missing arg")).toBe(true);
    expect(isFailureResult("User denied write permission.")).toBe(true);
    expect(isFailureResult("Edited src/main.py: 1 replacement(s)")).toBe(false);
  });

  // --- iteration limit returns the friendly, actionable message ---------------

  it("test_run_events_stops_at_iteration_limit", async () => {
    // The model always returns a tool call: the loop never "ends" on its own and
    // hits the round limit, returning the new message.
    config.maxIterations = 3;
    vi.mocked(chat).mockImplementation(async () => oneToolCallStream(10) as never); // below the threshold

    const agent = freshAgent();
    const events: ServerEvent[] = [];
    const result = await agent.runEvents("do something", (ev) => events.push(ev));

    expect(result).toContain("tool-iteration limit");
    expect(result).toContain("3 rounds"); // uses config.maxIterations
    expect(result).toContain("Ask me to continue");
    const done = events.filter((e) => e.type === "done");
    expect(done.length).toBeGreaterThan(0);
    expect((done[done.length - 1] as { content: string }).content).toBe(result);
  });

  // --- mid-turn compaction guard ----------------------------------------------

  it("test_midturn_compaction_triggers_compact", async () => {
    // last_prompt_tokens above the threshold, after appending the 'tool'
    // responses, triggers compact() and emits the "compacting context..." status.
    config.compactThreshold = 500;

    let n = 0;
    vi.mocked(chat).mockImplementation(async () => {
      n += 1;
      if (n === 1) return oneToolCallStream(1000) as never; // above the threshold
      return finalTextStream("all done") as never; // ends the turn on the 2nd round
    });

    const agent = freshAgent();
    // compact stub: records the call without depending on the summary LLM.
    const recorded: string[] = [];
    vi.spyOn(agent, "compact").mockImplementation(async () => {
      recorded.push("compact");
    });

    const events: ServerEvent[] = [];
    const result = await agent.runEvents("go", (ev) => events.push(ev));

    expect(result).toBe("all done");
    expect(recorded).toEqual(["compact"]); // compact called exactly once
    const statuses = events.filter(
      (e) => e.type === "status" && e.text === "compacting context...",
    );
    expect(statuses.length).toBeGreaterThan(0); // status event emitted before compact
  });

  // --- crash safety: the tool round is persisted before the turn ends ---------

  it("test_tool_round_saved_before_turn_end", async () => {
    let n = 0;
    vi.mocked(chat).mockImplementation(async () => {
      n += 1;
      if (n === 1) return oneToolCallStream(10) as never;
      return finalTextStream("all done") as never;
    });

    const agent = freshAgent();
    const snapshots: string[][] = [];
    const originalSave = agent.session.save.bind(agent.session);
    vi.spyOn(agent.session, "save").mockImplementation(() => {
      snapshots.push(agent.session.messages.map((m) => m.role));
      originalSave();
    });

    const result = await agent.runEvents("go", () => {});

    expect(result).toBe("all done");
    // there was a save with the complete round (last message 'tool'), before the end
    expect(snapshots.some((roles) => roles.length > 0 && roles[roles.length - 1] === "tool")).toBe(
      true,
    );
    // and the turn's final save also happened (ends on the final assistant)
    const last = snapshots[snapshots.length - 1]!;
    expect(last[last.length - 1]).toBe("assistant");
  });
});
