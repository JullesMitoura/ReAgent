// Regression tests for `reagent -p ... --json` (src/cli/main.ts), previously
// untested. This is the branch that had NO SIGINT handling at all (Ctrl+C
// during -p --json was left to Node's default behavior) and emitted a bare
// {"type":"error","message":...} instead of the structured error_info that
// `exec --json` already had. No network: vi.mock of ../src/llm/client.js.

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

const trustHooks = vi.hoisted(() => ({
  needsTrustPrompt: false,
  promptTrustCalls: 0,
  promptTrustResult: false,
}));
vi.mock("../src/trust.js", () => ({
  needsTrustPrompt: () => trustHooks.needsTrustPrompt,
  promptTrust: async () => {
    trustHooks.promptTrustCalls += 1;
    return trustHooks.promptTrustResult;
  },
  isProjectTrusted: () => false,
  trustProject: () => {},
}));

import { main } from "../src/cli/main.js";
import { config } from "../src/config.js";

const originalRoot = config.root;
const originalEnv = {
  endpoint: process.env.AZURE_OPENAI_ENDPOINT,
  key: process.env.AZURE_OPENAI_KEY,
  llm: process.env.AZURE_OPENAI_LLM,
};
let project: string;
let stdoutLines: string[];

beforeEach(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), "reagent-maincli-"));
  config.setRoot(project);
  config.autoApprove = true;
  config.contextFile = false;
  process.env.AZURE_OPENAI_ENDPOINT = "https://example.test";
  process.env.AZURE_OPENAI_KEY = "test-key";
  process.env.AZURE_OPENAI_LLM = "test-model";
  hooks.chatImpl = null;
  hooks.dispatchImpl = null;
  hooks.dispatchCalls = 0;
  trustHooks.needsTrustPrompt = false;
  trustHooks.promptTrustCalls = 0;
  trustHooks.promptTrustResult = false;
  stdoutLines = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    stdoutLines.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  config.setRoot(originalRoot);
  process.env.AZURE_OPENAI_ENDPOINT = originalEnv.endpoint;
  process.env.AZURE_OPENAI_KEY = originalEnv.key;
  process.env.AZURE_OPENAI_LLM = originalEnv.llm;
  fs.rmSync(project, { recursive: true, force: true });
});

function jsonLines(): unknown[] {
  return stdoutLines
    .join("")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

describe("-p --json CLI", () => {
  it("test_json_error_carries_structured_classification", async () => {
    hooks.chatImpl = () => {
      throw new Error("connection refused");
    };
    const code = await main(["-p", "do it", "--json"]);
    expect(code).toBe(1);
    const errorLine = jsonLines().find((l) => (l as { type?: string }).type === "error") as
      | { type: string; message: string; error_info?: { kind: string } }
      | undefined;
    expect(errorLine).toBeDefined();
    expect(errorLine!.error_info).toBeDefined();
    expect(typeof errorLine!.error_info!.kind).toBe("string");
  });

  it("test_sigint_emits_cancelled_and_stops_the_loop", async () => {
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

    const code = await main(["-p", "do it", "--json"]);
    expect(code).toBe(130);
    expect(jsonLines()).toContainEqual({ type: "cancelled" });

    const dispatchesAtCancel = hooks.dispatchCalls;
    await new Promise((r) => setTimeout(r, 20));
    expect(hooks.dispatchCalls).toBe(dispatchesAtCancel);
  });
});

// Regression tests for the trust-gate CLI wiring (security fix): a project
// whose config.json/hooks.json silently request something dangerous gets
// downgraded by config.setRoot() itself; main() additionally offers a
// one-time interactive review so a genuinely-trusted project can opt back in
// — but only when a human is actually there to answer (a real TTY).
describe("project trust prompt", () => {
  function finalTextStream(text: string): unknown[] {
    return [
      { choices: [{ delta: { content: text, tool_calls: null }, finish_reason: "stop" }], usage: null },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 3 } },
    ];
  }

  function withStdinTTY<T>(value: boolean, fn: () => Promise<T>): Promise<T> {
    const original = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value, configurable: true });
    return fn().finally(() => {
      if (original) Object.defineProperty(process.stdin, "isTTY", original);
    });
  }

  it("test_prompts_once_when_a_tty_is_attached_and_the_project_needs_review", async () => {
    trustHooks.needsTrustPrompt = true;
    trustHooks.promptTrustResult = true;
    hooks.chatImpl = () => finalTextStream("hi there");

    const code = await withStdinTTY(true, () => main(["-p", "hi", "--json"]));

    expect(code).toBe(0);
    expect(trustHooks.promptTrustCalls).toBe(1);
  });

  it("test_never_prompts_without_a_real_tty_even_when_the_project_needs_review", async () => {
    trustHooks.needsTrustPrompt = true;
    hooks.chatImpl = () => finalTextStream("hi there");

    const code = await withStdinTTY(false, () => main(["-p", "hi", "--json"]));

    expect(code).toBe(0);
    expect(trustHooks.promptTrustCalls).toBe(0);
  });

  it("test_does_not_prompt_when_the_project_does_not_need_review", async () => {
    trustHooks.needsTrustPrompt = false;
    hooks.chatImpl = () => finalTextStream("hi there");

    await withStdinTTY(true, () => main(["-p", "hi", "--json"]));

    expect(trustHooks.promptTrustCalls).toBe(0);
  });
});
