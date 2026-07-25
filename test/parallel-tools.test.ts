// 1:1 mirror of tests/test_parallel_tools.py (4 tests): Agent.dispatchParallel
// + the loop gating (a 100% read-only round runs concurrently; any
// write/question keeps everything sequential in the calls' original order).
//
// No network: Python's monkeypatch of src.agent.dispatch becomes vi.mock of
// ../src/tools/index.js (override only of dispatch, the rest real) and that of
// src.llm.chat becomes vi.mock of ../src/llm/client.js with synthetic streams. The
// concurrency proof uses a promise barrier (deadlock if sequential), equivalent to
// Python's threading.Barrier under Node's Promise.all model.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/system-prompt.js", () => ({ buildSystemPrompt: () => "sys" }));

vi.mock("../src/llm/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/llm/client.js")>();
  return { ...actual, chat: vi.fn(actual.chat) };
});

vi.mock("../src/tools/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/tools/index.js")>();
  return { ...actual, dispatch: vi.fn(actual.dispatch) };
});

import { Agent } from "../src/agent.js";
import { config } from "../src/config.js";
import { chat } from "../src/llm/client.js";
import { Session } from "../src/session.js";
import { dispatch } from "../src/tools/index.js";

// --- streaming fakes (multiple tool calls in one round) -----------------------
function roundStream(calls: [string, string, string][]): unknown[] {
  const deltas = calls.map(([cid, name, args], i) => ({
    index: i,
    id: cid,
    function: { name, arguments: args },
  }));
  return [
    { choices: [{ delta: { content: null, tool_calls: deltas }, finish_reason: null }], usage: null },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
  ];
}

function finalStream(text: string): unknown[] {
  return [
    { choices: [{ delta: { content: text, tool_calls: null }, finish_reason: null }], usage: null },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 3 } },
  ];
}

/** Makes chat() return each `rounds` response in sequence. */
function drive(rounds: unknown[][]): void {
  let i = 0;
  vi.mocked(chat).mockImplementation(async () => {
    const r = rounds[i];
    i += 1;
    return r as never;
  });
}

/** Barrier of N promises: they only resolve when all N have entered (else deadlock). */
function makeBarrier(n: number, timeoutMs = 3000): (val: string) => Promise<string> {
  let entered = 0;
  const releases: Array<() => void> = [];
  return (val: string) =>
    new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("barrier deadlock: dispatch did not run concurrently")),
        timeoutMs,
      );
      releases.push(() => {
        clearTimeout(timer);
        resolve(val);
      });
      entered += 1;
      if (entered === n) for (const r of releases) r();
    });
}

function freshAgent(): Agent {
  const s = Session.new();
  s.messages = [{ role: "system", content: "sys" }];
  return new Agent(s);
}

const originalRoot = config.root;
let project: string;

beforeEach(() => {
  project = config.setRoot(fs.mkdtempSync(path.join(os.tmpdir(), "reagent-partools-")));
  config.autoApprove = true;
  config.contextFile = false;
});

afterEach(() => {
  vi.mocked(chat).mockReset();
  vi.mocked(dispatch).mockReset();
  config.setRoot(originalRoot);
  fs.rmSync(project, { recursive: true, force: true });
});

describe("parallel-tools", () => {
  // --- unit: dispatchParallel really runs concurrently and maps by id ----------
  it("test_dispatch_parallel_runs_concurrently_and_maps_by_id", async () => {
    const n = 3;
    const barrier = makeBarrier(n); // only passes if the 3 run together
    vi.mocked(dispatch).mockImplementation((name, args) => barrier(`${name}:${args}`));

    const agent = freshAgent();
    const toolCalls = [];
    for (let i = 0; i < n; i++) {
      toolCalls.push({ id: `c${i}`, name: "read_file", arguments: `{"path":"f${i}"}` });
    }

    const results = await agent.dispatchParallel(toolCalls);

    expect(new Set(Object.keys(results))).toEqual(new Set(["c0", "c1", "c2"]));
    expect(results["c1"]).toBe('read_file:{"path":"f1"}');
  });

  // --- integration: a read-only round runs tools concurrently, order preserved ---
  it("test_all_readonly_round_uses_parallel_path", async () => {
    drive([roundStream([["c0", "read_file", "{}"], ["c1", "grep", "{}"]]), finalStream("done")]);
    vi.mocked(dispatch).mockImplementation(async (name) => `out-${name}`);

    const agent = freshAgent();
    let calledWith: string[] | null = null;
    const real = agent.dispatchParallel.bind(agent);
    vi.spyOn(agent, "dispatchParallel").mockImplementation((tcs) => {
      calledWith = tcs.map((t) => t.id);
      return real(tcs);
    });

    await agent.runEvents("go", () => {});

    // Either dispatchParallel (legacy batch) or mid-stream StreamingToolExecutor.
    const tools = agent.messages.filter((m) => m.role === "tool");
    expect(tools.map((m) => m.tool_call_id)).toEqual(["c0", "c1"]); // order preserved
    expect(tools.map((m) => m.content)).toEqual(["out-read_file", "out-grep"]);
    if (calledWith !== null) {
      expect(calledWith).toEqual(["c0", "c1"]);
    } else {
      expect(vi.mocked(dispatch).mock.calls.map((c) => c[0]).sort()).toEqual(["grep", "read_file"]);
    }
  });

  // --- integration: a mixed round (read + write) does NOT parallelize -----------
  it("test_mixed_round_stays_sequential", async () => {
    drive([roundStream([["c0", "read_file", "{}"], ["c1", "write_file", "{}"]]), finalStream("done")]);
    vi.mocked(dispatch).mockImplementation(async (name) => `out-${name}`);

    const agent = freshAgent();
    let called = false;
    vi.spyOn(agent, "dispatchParallel").mockImplementation(async () => {
      called = true;
      return {};
    });

    await agent.runEvents("go", () => {});

    expect(called).toBe(false); // a write in the round -> sequential
    const tools = agent.messages.filter((m) => m.role === "tool");
    expect(tools.map((m) => m.tool_call_id)).toEqual(["c0", "c1"]); // order preserved
  });

  // --- integration: a single tool call never goes to the parallel path ----------
  it("test_single_tool_call_not_parallel", async () => {
    drive([roundStream([["c0", "read_file", "{}"]]), finalStream("done")]);
    vi.mocked(dispatch).mockImplementation(async () => "out");

    const agent = freshAgent();
    let called = false;
    vi.spyOn(agent, "dispatchParallel").mockImplementation(async () => {
      called = true;
      return {};
    });

    await agent.runEvents("go", () => {});

    expect(called).toBe(false);
  });
});
