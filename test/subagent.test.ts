// 1:1 mirror of tests/test_subagent.py (5 tests): the explore tool
// (read-only sub-agent).
//
// No network: Python's monkeypatch of src.llm.chat becomes a vi.mock of
// ../src/llm/client.js with scripted NON-streaming responses. The read-only
// tool calls go through the REAL dispatch in a temporary project
// (conftest's `project` fixture becomes beforeEach with fs.mkdtempSync).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { config } from "../src/config.js";

// vi.mock hoisted: replaces chat for subagent.ts (which imports from the same
// resolved path). Passthrough to the real one, overridden per test.
vi.mock("../src/llm/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/llm/client.js")>();
  return { ...actual, chat: vi.fn(actual.chat) };
});

import { chat } from "../src/llm/client.js";
import { explore } from "../src/tools/subagent.js";

// --- non-streaming response fakes (resp.choices[0].message) ----------------
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

/** Routes chat() by sequence; returns a call counter. */
function script(responses: unknown[]): { i: number } {
  const seq = { i: 0 };
  vi.mocked(chat).mockImplementation(async () => {
    const r = responses[seq.i];
    seq.i += 1;
    return r as never;
  });
  return seq;
}

const originalRoot = config.root;
const originalEnableSubagent = config.enableSubagent;
const originalMaxSteps = config.subagentMaxSteps;
let project: string;

beforeEach(() => {
  project = config.setRoot(fs.mkdtempSync(path.join(os.tmpdir(), "reagent-subagent-")));
  config.autoApprove = true;
  config.contextFile = false;
});

afterEach(() => {
  vi.mocked(chat).mockReset();
  config.enableSubagent = originalEnableSubagent;
  config.subagentMaxSteps = originalMaxSteps;
  config.setRoot(originalRoot);
  fs.rmSync(project, { recursive: true, force: true });
});

describe("subagent", () => {
  it("test_disabled_by_default", async () => {
    config.enableSubagent = false;
    const out = await explore("x", "y");
    expect(out.startsWith("Error: the explore tool is disabled")).toBe(true);
  });

  it("test_reads_then_returns_summary", async () => {
    config.enableSubagent = true;
    fs.writeFileSync(path.join(config.root, "notes.txt"), "the answer is 42\n");
    script([
      toolResp("c0", "read_file", '{"path": "notes.txt"}'),
      textResp("FOUND: the answer is 42 (notes.txt:1)"),
    ]);
    const out = await explore("find the answer", "Read notes.txt and report the answer.");
    // the caller only gets the final summary, nothing from the intermediate reads
    expect(out.replace(/\n\n\(agent-id: [^)]+\)\s*$/, "")).toBe(
      "FOUND: the answer is 42 (notes.txt:1)",
    );
  });

  it("test_refuses_write_tools", async () => {
    config.enableSubagent = true;
    const seq = script([
      toolResp("c0", "write_file", '{"path": "hacked.txt", "content": "x"}'),
      textResp("could not write, as expected"),
    ]);
    const out = await explore("try to write", "Attempt to create a file.");
    expect(out.replace(/\n\n\(agent-id: [^)]+\)\s*$/, "")).toBe("could not write, as expected");
    expect(fs.existsSync(path.join(config.root, "hacked.txt"))).toBe(false); // the write never happened
    expect(seq.i).toBe(2); // two rounds: refused attempt + summary
  });

  it("test_cannot_recurse", async () => {
    config.enableSubagent = true;
    const captured: { tools?: unknown } = {};
    vi.mocked(chat).mockImplementation(async (_messages, tools) => {
      // the 1st call carries the tool set offered to the sub-agent
      if (!("tools" in captured)) captured.tools = tools;
      return textResp("done") as never;
    });
    await explore("x", "y");
    const names = new Set(
      ((captured.tools as { function: { name: string } }[]) || []).map((s) => s.function.name),
    );
    expect(names.has("explore")).toBe(false); // the sub-agent does not receive itself (no recursion)
    expect(names.has("write_file")).toBe(false);
    expect(names.has("bash")).toBe(false);
    for (const n of ["read_file", "grep", "glob", "list_dir"]) expect(names.has(n)).toBe(true);
  });

  it("test_step_budget_forces_summary", async () => {
    config.enableSubagent = true;
    config.subagentMaxSteps = 3;
    fs.writeFileSync(path.join(config.root, "a.txt"), "data\n");
    // always returns a tool call: never "finishes" on its own -> forces a summary at the end
    const responses: unknown[] = [];
    for (let i = 0; i < 3; i++) responses.push(toolResp(`c${i}`, "read_file", '{"path": "a.txt"}'));
    responses.push(textResp("final summary after budget"));
    const seq = script(responses);
    const out = await explore("loop", "keep reading");
    expect(out.replace(/\n\n\(agent-id: [^)]+\)\s*$/, "")).toBe("final summary after budget");
    expect(seq.i).toBe(4); // 3 rounds + the forced-summary call
  });
});
