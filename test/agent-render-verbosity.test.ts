// Regression tests for the CLI UX redesign: config.verbosity gates how much
// execution detail agent-render.ts's runTurn() prints. Captures the actual
// written output (no TTY, so the spinner stays silent and only explicit
// writes show up) and asserts on what each level does/doesn't reveal.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/system-prompt.js", () => ({ buildSystemPrompt: () => "sys" }));

vi.mock("../src/llm/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/llm/client.js")>();
  return { ...actual, chat: vi.fn(actual.chat) };
});

import { Agent } from "../src/agent.js";
import { STATUS_COMPACTING } from "../src/agent/status.js";
import { runTurn } from "../src/agent-render.js";
import { config } from "../src/config.js";
import { chat } from "../src/llm/client.js";
import { Session } from "../src/session.js";

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
function oneToolCallStream(name: string, args: string): unknown[] {
  return [
    deltaChunk({ content: null, tool_calls: [{ index: 0, id: "c0", function: { name, arguments: args } }] }),
    usageChunk(10, 5),
  ];
}
function finalTextStream(text: string): unknown[] {
  return [deltaChunk({ content: text, tool_calls: null }), usageChunk(10, 3)];
}

function freshAgent(): Agent {
  const s = Session.new();
  s.messages = [{ role: "system", content: "sys" }];
  return new Agent(s);
}

function fakeOut(): { stream: NodeJS.WriteStream; text(): string } {
  const chunks: string[] = [];
  const stream = {
    isTTY: false,
    write: (chunk: string): boolean => {
      chunks.push(chunk);
      return true;
    },
  } as unknown as NodeJS.WriteStream;
  return { stream, text: () => chunks.join("") };
}

const originalRoot = config.root;
const originalVerbosity = config.verbosity;
let project: string;

beforeEach(() => {
  project = config.setRoot(fs.mkdtempSync(path.join(os.tmpdir(), "reagent-render-verbosity-")));
  config.autoApprove = true;
  config.contextFile = false;
});

afterEach(() => {
  vi.mocked(chat).mockReset();
  config.setVerbosity(originalVerbosity);
  config.setRoot(originalRoot);
  fs.rmSync(project, { recursive: true, force: true });
});

async function runOneToolTurn(): Promise<string> {
  let n = 0;
  vi.mocked(chat).mockImplementation(async () => {
    n += 1;
    if (n === 1) {
      return oneToolCallStream("write_file", '{"path":"note.txt","content":"hi"}') as never;
    }
    return finalTextStream("all done") as never;
  });
  const agent = freshAgent();
  const out = fakeOut();
  await runTurn(agent, "write a note", out.stream);
  return out.text();
}

describe("agent-render verbosity", () => {
  it("test_quiet_hides_tool_activity_but_keeps_the_final_answer", async () => {
    config.setVerbosity("quiet");
    const text = await runOneToolTurn();
    expect(text).not.toContain("write_file");
    expect(text).not.toContain("Writing");
    expect(text).toContain("all done");
  });

  it("test_normal_shows_a_friendly_label_never_the_raw_tool_name", async () => {
    config.setVerbosity("normal");
    const text = await runOneToolTurn();
    expect(text).toContain("Writing note.txt");
    expect(text).not.toContain("write_file(");
    expect(text).toContain("all done");
  });

  it("test_verbose_adds_a_technical_line_alongside_the_friendly_label", async () => {
    config.setVerbosity("verbose");
    const text = await runOneToolTurn();
    expect(text).toContain("Writing note.txt");
    expect(text).toContain("write_file(");
  });

  it("test_debug_shows_the_raw_tool_call_instead_of_the_friendly_label", async () => {
    config.setVerbosity("debug");
    const text = await runOneToolTurn();
    expect(text).toContain("write_file(");
  });

  // Regression test: query.ts re-emits a generic {type:"status", text:
  // "Thinking…"} status event before the first round AND after every round
  // that ran tools (agent/query.ts). Printing that as a permanent line (as
  // any other status text correctly does) stacked a new stuck "Thinking…"
  // line above the live spinner on every round, since the spinner's own
  // \r-redraw only clears its own line, never ones already scrolled past.
  it("test_generic_thinking_status_never_prints_a_stuck_permanent_line", async () => {
    config.setVerbosity("normal");
    let n = 0;
    vi.mocked(chat).mockImplementation(async () => {
      n += 1;
      // Two tool rounds: query.ts emits STATUS_THINKING again after each one.
      if (n === 1 || n === 2) return oneToolCallStream("list_dir", "{}") as never;
      return finalTextStream("all done") as never;
    });
    const agent = freshAgent();
    const out = fakeOut();
    await runTurn(agent, "look around twice", out.stream);
    const text = out.text();
    expect(text).not.toContain("Thinking…");
    expect(text).toContain("all done");
  });

  it("test_a_real_status_change_still_prints_a_permanent_line", async () => {
    config.setVerbosity("normal");
    config.compactThreshold = 500; // the round's usage (1000) exceeds it, forcing compaction
    let n = 0;
    vi.mocked(chat).mockImplementation(async () => {
      n += 1;
      if (n === 1) {
        return [
          deltaChunk({
            content: null,
            tool_calls: [{ index: 0, id: "c0", function: { name: "list_dir", arguments: "{}" } }],
          }),
          usageChunk(1000, 5),
        ] as never;
      }
      return finalTextStream("all done") as never;
    });
    const agent = freshAgent();
    vi.spyOn(agent, "compact").mockImplementation(async () => {});
    const out = fakeOut();
    await runTurn(agent, "go", out.stream);
    expect(out.text()).toContain(STATUS_COMPACTING);
  });
});
