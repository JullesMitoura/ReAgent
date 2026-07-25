// Regression tests for `reagent exec` (src/cli/exec.ts), a documented CLI
// entrypoint with no prior test coverage. Covers three fixes made together:
// - --json errors now carry the same structured `error_info` (classify/
//   userMessage) that `-p --json` already had, instead of a bare message.
// - hitting the tool-iteration limit returns exit code 3 (not 0), so a CI
//   script can tell "gave up on the round budget" apart from "finished".
// - Ctrl+C (SIGINT) sets the turn's cancel flag, so the agent loop actually
//   stops instead of continuing to run detached after the CLI returns 130.
//
// No network: vi.mock of ../src/llm/client.js (abort.test.ts pattern).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/system-prompt.js", () => ({ buildSystemPrompt: () => "sys" }));

const hooks = vi.hoisted(() => ({
  chatImpl: null as null | (() => unknown),
  dispatchImpl: null as null | ((name: string, args: string) => string | Promise<string>),
  dispatchCalls: 0,
}));

vi.mock("../src/llm/client.js", () => ({
  chat: () => (hooks.chatImpl ? hooks.chatImpl() : []),
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
      return hooks.dispatchImpl ? hooks.dispatchImpl(name, args) : actual.dispatch(name, args);
    },
  };
});

import { execMain } from "../src/cli/exec.js";
import { config } from "../src/config.js";

const originalRoot = config.root;
const originalMaxIterations = config.maxIterations;
let project: string;
let stdoutLines: string[];
let stderrLines: string[];

beforeEach(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), "reagent-exec-"));
  config.setRoot(project);
  config.autoApprove = true;
  config.contextFile = false;
  hooks.chatImpl = null;
  hooks.dispatchImpl = null;
  hooks.dispatchCalls = 0;
  stdoutLines = [];
  stderrLines = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    stdoutLines.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    stderrLines.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  config.setRoot(originalRoot);
  config.maxIterations = originalMaxIterations;
  fs.rmSync(project, { recursive: true, force: true });
});

function jsonLines(): unknown[] {
  return stdoutLines
    .join("")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

// A stream chunk pair that always requests the same tool call again.
function toolCallStream(): unknown[] {
  const tc = { index: 0, id: "c0", function: { name: "list_dir", arguments: "{}" } };
  return [
    { choices: [{ delta: { content: null, tool_calls: [tc] }, finish_reason: null }], usage: null },
    {
      choices: [{ delta: { content: null, tool_calls: null }, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    },
  ];
}

describe("exec CLI", () => {
  it("test_json_error_carries_structured_classification", async () => {
    hooks.chatImpl = () => {
      throw new Error("connection refused");
    };
    const code = await execMain(["do it", "--json"]);
    expect(code).toBe(1);
    const errorLine = jsonLines().find((l) => (l as { type?: string }).type === "error") as
      | { type: string; message: string; error_info?: { kind: string } }
      | undefined;
    expect(errorLine).toBeDefined();
    expect(errorLine!.error_info).toBeDefined();
    expect(typeof errorLine!.error_info!.kind).toBe("string");
  });

  it("test_reaching_iteration_limit_returns_exit_code_3", async () => {
    config.maxIterations = 1;
    hooks.chatImpl = () => toolCallStream();
    const code = await execMain(["do it"]);
    expect(code).toBe(3);
    expect(stderrLines.join("")).toContain("tool-iteration limit");
  });

  it("test_sigint_stops_the_loop_instead_of_running_detached", async () => {
    let round = 0;
    hooks.chatImpl = () => {
      round += 1;
      const tc = {
        index: 0,
        id: `c${round}`,
        function: { name: "list_dir", arguments: JSON.stringify({ round }) },
      };
      return [
        { choices: [{ delta: { content: null, tool_calls: [tc] }, finish_reason: null }], usage: null },
        {
          choices: [{ delta: { content: null, tool_calls: null }, finish_reason: "tool_calls" }],
          usage: { prompt_tokens: 10, completion_tokens: 2 },
        },
      ];
    };
    hooks.dispatchImpl = () => {
      if (hooks.dispatchCalls === 2) process.emit("SIGINT");
      return "ok";
    };

    const code = await execMain(["do it"]);
    expect(code).toBe(130);
    const dispatchesAtCancel = hooks.dispatchCalls;
    await new Promise((r) => setTimeout(r, 20));
    expect(hooks.dispatchCalls).toBe(dispatchesAtCancel);
  });
});
