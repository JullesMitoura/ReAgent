// Tests for the parallel_agents tool (src/tools/parallel.ts).
//
// test_parallel_tools.py covers Agent._dispatch_parallel + loop gating (agent.ts
// area, phase 6), not the parallel_agents tool itself; therefore here are
// validations specific to the port of parallel.py: literal error messages,
// task filtering/limits, aggregated report format, the
// agents_start/agent_update/agents_end events scoped by TurnContext, refusal of a tool
// outside the worker set, doom-loop breaking, step budget and the
// order preservation of Promise.all.
//
// No network: vi.mock of ../src/llm/client.js with non-streaming responses
// routed by a tag in each task's prompt (workers run concurrently).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { config } from "../src/config.js";
import { doomLoopWorkerMessage } from "../src/lib/doom-loop.js";
import { newTurnContext, runWithTurn } from "../src/turn-context.js";
import type { ChatMessage, ServerEvent } from "../src/types.js";

vi.mock("../src/llm/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/llm/client.js")>();
  return { ...actual, chat: vi.fn(actual.chat) };
});

import { chat } from "../src/llm/client.js";
import { parallelAgents } from "../src/tools/parallel.js";

// --- non-streaming response fakes ---------------------------------------------
interface FakeMessage {
  content?: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] | null;
}
function toolResp(cid: string, name: string, args: string): { choices: { message: FakeMessage }[] } {
  return {
    choices: [{ message: { content: null, tool_calls: [{ id: cid, type: "function", function: { name, arguments: args } }] } }],
  };
}
function textResp(text: string): { choices: { message: FakeMessage }[] } {
  return { choices: [{ message: { content: text, tool_calls: null } }] };
}

/**
 * Routes chat() by a tag present in each task's prompt. Workers run
 * concurrently, so the route cannot depend on global order: each call
 * inspects its OWN messages. Returns the history captured per call.
 */
function scriptByTag(entries: { tag: string; responses: unknown[] }[]): { captured: ChatMessage[][] } {
  const counters: Record<string, number> = {};
  const captured: ChatMessage[][] = [];
  vi.mocked(chat).mockImplementation(async (messages) => {
    captured.push(messages as ChatMessage[]);
    const text = (messages as ChatMessage[]).map((m) => String(m.content ?? "")).join("\n");
    for (const e of entries) {
      if (text.includes(e.tag)) {
        const idx = counters[e.tag] ?? 0;
        counters[e.tag] = idx + 1;
        return e.responses[Math.min(idx, e.responses.length - 1)] as never;
      }
    }
    return textResp("(unrouted)") as never;
  });
  return { captured };
}

const originalRoot = config.root;
const originalEnableParallel = config.enableParallel;
const originalMaxAgents = config.parallelMaxAgents;
const originalMaxSteps = config.parallelMaxSteps;
let project: string;

beforeEach(() => {
  project = config.setRoot(fs.mkdtempSync(path.join(os.tmpdir(), "reagent-parallel-")));
  config.autoApprove = true;
  config.contextFile = false;
  config.enableParallel = true;
});

afterEach(() => {
  vi.mocked(chat).mockReset();
  config.enableParallel = originalEnableParallel;
  config.parallelMaxAgents = originalMaxAgents;
  config.parallelMaxSteps = originalMaxSteps;
  config.setRoot(originalRoot);
  fs.rmSync(project, { recursive: true, force: true });
});

describe("parallel_agents", () => {
  it("test_disabled_returns_error", async () => {
    config.enableParallel = false;
    const out = await parallelAgents([
      { title: "A", prompt: "x" },
      { title: "B", prompt: "y" },
    ]);
    expect(out).toBe(
      'Error: the parallel_agents tool is disabled (set "parallel_agents": true in .reagent/config.json)',
    );
  });

  it("test_rejects_non_list_of_objects", async () => {
    expect(await parallelAgents("nope")).toBe("Error: tasks must be a list of {title, prompt} objects");
    expect(await parallelAgents([{ title: "A", prompt: "x" }, "str"])).toBe(
      "Error: tasks must be a list of {title, prompt} objects",
    );
  });

  it("test_needs_at_least_two_tasks", async () => {
    const out = await parallelAgents([{ title: "solo", prompt: "do it" }]);
    expect(out).toBe(
      "Error: parallel_agents needs at least 2 independent tasks; do a single task yourself",
    );
  });

  it("test_blank_tasks_filtered_below_two_errors", async () => {
    const out = await parallelAgents([
      { title: "A", prompt: "keep me" },
      { title: "", prompt: "no title" },
      { title: "B", prompt: "   " },
    ]);
    expect(out).toBe(
      "Error: parallel_agents needs at least 2 independent tasks; do a single task yourself",
    );
  });

  it("test_rejects_too_many_tasks", async () => {
    config.parallelMaxAgents = 3; // deterministic cap for this assertion (restored in afterEach)
    const tasks = [1, 2, 3, 4].map((n) => ({ title: `t${n}`, prompt: `p${n}` }));
    const out = await parallelAgents(tasks);
    expect(out).toBe("Error: at most 3 parallel tasks (got 4); merge or drop some");
  });

  it("test_runs_workers_and_aggregates_reports", async () => {
    scriptByTag([
      { tag: "ALPHA", responses: [textResp("report A")] },
      { tag: "BETA", responses: [textResp("report B")] },
    ]);
    const out = await parallelAgents([
      { title: "Title A", prompt: "ALPHA task" },
      { title: "Title B", prompt: "BETA task" },
    ]);
    expect(out).toBe(
      "All 2 parallel workers finished. Reports:\n\n### Title A [done]\nreport A\n\n### Title B [done]\nreport B",
    );
  });

  it("test_title_truncated_to_60_chars", async () => {
    scriptByTag([
      { tag: "ALPHA", responses: [textResp("a")] },
      { tag: "BETA", responses: [textResp("b")] },
    ]);
    const longTitle = "T".repeat(80);
    const out = await parallelAgents([
      { title: longTitle, prompt: "ALPHA task" },
      { title: "Short", prompt: "BETA task" },
    ]);
    expect(out).toContain(`### ${"T".repeat(60)} [done]`);
    expect(out).not.toContain("T".repeat(61));
  });

  it("test_emits_agents_events_scoped_to_turn", async () => {
    fs.writeFileSync(path.join(config.root, "notes.txt"), "hi\n");
    scriptByTag([
      { tag: "ALPHA", responses: [toolResp("c0", "read_file", '{"path": "notes.txt"}'), textResp("did A")] },
      { tag: "BETA", responses: [textResp("did B")] },
    ]);
    const events: ServerEvent[] = [];
    const ctx = newTurnContext({ emit: (ev) => events.push(ev) });
    const out = await runWithTurn(ctx, () =>
      parallelAgents([
        { title: "Title A", prompt: "ALPHA task" },
        { title: "Title B", prompt: "BETA task" },
      ]),
    );
    expect(out).toContain("All 2 parallel workers finished.");

    // agents_start first, with both branches in the original order.
    expect(events[0]).toEqual({
      type: "agents_start",
      agents: [
        { id: "a1", title: "Title A" },
        { id: "a2", title: "Title B" },
      ],
    });
    // agents_end last.
    expect(events[events.length - 1]).toEqual({ type: "agents_end" });

    // worker A "running" update with the short call label.
    expect(events).toContainEqual({
      type: "agent_update",
      id: "a1",
      status: "running",
      detail: "read_file notes.txt",
    });
    // final "done" updates for each branch with the first line of the report.
    expect(events).toContainEqual({ type: "agent_update", id: "a1", status: "done", detail: "did A" });
    expect(events).toContainEqual({ type: "agent_update", id: "a2", status: "done", detail: "did B" });
  });

  it("test_emitter_scoped_no_events_without_turn", async () => {
    // Without a TurnContext there is no emitter: must not throw (safeEmit is a no-op).
    scriptByTag([
      { tag: "ALPHA", responses: [textResp("a")] },
      { tag: "BETA", responses: [textResp("b")] },
    ]);
    const out = await parallelAgents([
      { title: "Title A", prompt: "ALPHA task" },
      { title: "Title B", prompt: "BETA task" },
    ]);
    expect(out).toContain("All 2 parallel workers finished.");
  });

  it("test_worker_refuses_non_worker_tools", async () => {
    const { captured } = scriptByTag([
      { tag: "ALPHA", responses: [toolResp("c0", "question", '{"question": "hi"}'), textResp("did A")] },
      { tag: "BETA", responses: [textResp("did B")] },
    ]);
    await parallelAgents([
      { title: "Title A", prompt: "ALPHA task" },
      { title: "Title B", prompt: "BETA task" },
    ]);
    const refusal =
      "Error: worker agents may only use these tools: apply_patch, bash, delete_file, edit_file, " +
      "glob, grep, list_dir, multi_edit, read_file, structured_output, write_file";
    const toolMsgs = captured.flat().filter((m) => m.role === "tool");
    expect(toolMsgs.some((m) => m.content === refusal)).toBe(true);
    // The forbidden tool never executed: no question response in the history.
    expect(toolMsgs.some((m) => String(m.content ?? "").includes("non-interactive"))).toBe(false);
  });

  it("test_worker_doom_loop_breaks_repeated_calls", async () => {
    config.parallelMaxSteps = 3;
    fs.writeFileSync(path.join(config.root, "a.txt"), "data\n");
    const { captured } = scriptByTag([
      {
        tag: "ALPHA",
        responses: [
          toolResp("c0", "read_file", '{"path": "a.txt"}'),
          toolResp("c1", "read_file", '{"path": "a.txt"}'),
          toolResp("c2", "read_file", '{"path": "a.txt"}'),
          textResp("done A"),
        ],
      },
      { tag: "BETA", responses: [textResp("did B")] },
    ]);
    await parallelAgents([
      { title: "Title A", prompt: "ALPHA task" },
      { title: "Title B", prompt: "BETA task" },
    ]);
    // The 3rd identical call in a row becomes the worker's doom-loop message.
    const toolMsgs = captured.flat().filter((m) => m.role === "tool");
    expect(toolMsgs.some((m) => m.content === doomLoopWorkerMessage("read_file"))).toBe(true);
  });

  it("test_worker_step_budget_forces_summary", async () => {
    config.parallelMaxSteps = 2;
    fs.writeFileSync(path.join(config.root, "a.txt"), "data\n");
    // Worker A never "finishes" on its own: always a tool call -> forces a summary.
    scriptByTag([
      {
        tag: "ALPHA",
        responses: [
          toolResp("c0", "read_file", '{"path": "a.txt"}'),
          toolResp("c1", "list_dir", "{}"),
          textResp("forced report A"),
        ],
      },
      { tag: "BETA", responses: [textResp("did B")] },
    ]);
    const out = await parallelAgents([
      { title: "Title A", prompt: "ALPHA task" },
      { title: "Title B", prompt: "BETA task" },
    ]);
    // "forced report A" can only come from the post-budget summary call.
    expect(out).toContain("### Title A [done]\nforced report A");
  });

  it("test_worker_can_read_and_write", async () => {
    fs.writeFileSync(path.join(config.root, "src.txt"), "SOURCE\n");
    scriptByTag([
      {
        tag: "ALPHA",
        responses: [
          toolResp("c0", "read_file", '{"path": "src.txt"}'),
          toolResp("c1", "write_file", '{"path": "out.txt", "content": "hello"}'),
          textResp("wrote out.txt"),
        ],
      },
      { tag: "BETA", responses: [textResp("did B")] },
    ]);
    const out = await parallelAgents([
      { title: "Title A", prompt: "ALPHA task" },
      { title: "Title B", prompt: "BETA task" },
    ]);
    expect(fs.existsSync(path.join(config.root, "out.txt"))).toBe(true);
    expect(fs.readFileSync(path.join(config.root, "out.txt"), "utf8")).toBe("hello");
    expect(out).toContain("### Title A [done]\nwrote out.txt");
  });

  it("test_report_order_preserved_regardless_of_completion", async () => {
    // Worker A responds with a delay; B finishes first. The aggregated report still
    // lists A before B (Promise.all preserves task order).
    const counters: Record<string, number> = {};
    vi.mocked(chat).mockImplementation(async (messages) => {
      const text = (messages as ChatMessage[]).map((m) => String(m.content ?? "")).join("\n");
      const isA = text.includes("ALPHA");
      const tag = isA ? "ALPHA" : "BETA";
      counters[tag] = (counters[tag] ?? 0) + 1;
      if (isA) {
        await new Promise((r) => setTimeout(r, 20));
        return textResp("report A") as never;
      }
      return textResp("report B") as never;
    });
    const out = await parallelAgents([
      { title: "Title A", prompt: "ALPHA task" },
      { title: "Title B", prompt: "BETA task" },
    ]);
    expect(out).toBe(
      "All 2 parallel workers finished. Reports:\n\n### Title A [done]\nreport A\n\n### Title B [done]\nreport B",
    );
  });
});
