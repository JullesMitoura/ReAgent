// Coverage for four tools that are registered via registerTool() (see the
// side-effect imports in src/agent/query-engine.ts) but were not exercised by
// any test: workflow (src/tools/workflow.ts), skill (src/skills/tool.ts),
// tool_search (src/tools/tool-search.ts) and structured_output
// (src/tools/structured-output.ts).
//
// Same hermetic pattern as test/subagent.test.ts and test/apply-patch.test.ts:
// a temp project root via config.setRoot, dispatch() from the real registry
// (no dispatch mocking), and a vi.mock of ../src/llm/client.js for the one
// path that actually talks to a model (workflow's happy path spawns a
// sub-agent through the shared tool-loop).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { config } from "../src/config.js";
import { dispatch } from "../src/tools/index.js";
import { newTurnContext, runWithTurn } from "../src/turn-context.js";

// Side-effect imports: each module calls registerTool() at load time, the
// same way src/agent/query-engine.ts wires them into the real REGISTRY.
import "../src/tools/workflow.js";
import "../src/skills/tool.js";
import "../src/tools/tool-search.js";
import "../src/tools/structured-output.js";

vi.mock("../src/llm/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/llm/client.js")>();
  return { ...actual, chat: vi.fn(actual.chat) };
});

import { chat } from "../src/llm/client.js";

function textResp(text: string): { choices: { message: { content: string; tool_calls: null } }[] } {
  return { choices: [{ message: { content: text, tool_calls: null } }] };
}

const originalRoot = config.root;
const originalEnableWorkflow = config.enableWorkflow;
const originalEnableDeferredTools = config.enableDeferredTools;
let project: string;

beforeEach(() => {
  project = config.setRoot(fs.mkdtempSync(path.join(os.tmpdir(), "reagent-deferred-tools-")));
  config.autoApprove = true;
  config.contextFile = false;
});

afterEach(() => {
  vi.mocked(chat).mockReset();
  config.enableWorkflow = originalEnableWorkflow;
  config.enableDeferredTools = originalEnableDeferredTools;
  config.setRoot(originalRoot);
  fs.rmSync(project, { recursive: true, force: true });
});

describe("structured_output tool", () => {
  it("formats a well-formed report (happy path)", async () => {
    const out = await dispatch(
      "structured_output",
      JSON.stringify({
        status: "done",
        summary: "did the thing",
        files_changed: ["a.ts", "b.ts"],
        details: "more info",
      }),
    );
    expect(out).toBe("[done] did the thing\nfiles: a.ts, b.ts\n\nmore info");
  });

  it("returns an Error: string instead of throwing on malformed arguments", async () => {
    const out = await dispatch("structured_output", "{not json");
    expect(out).toBe("Error: arguments are not valid JSON");
  });
});

describe("tool_search tool", () => {
  it("activates a matching deferred tool for the current turn (happy path)", async () => {
    config.enableDeferredTools = true;
    const ctx = newTurnContext({});
    const out = await runWithTurn(ctx, () =>
      dispatch("tool_search", JSON.stringify({ query: "workflow" })),
    );
    expect(out).toContain("Activated for this turn: workflow");
    expect(ctx.enabledDeferred.has("workflow")).toBe(true);
  });

  it("returns an Argument error: string when 'query' is missing", async () => {
    config.enableDeferredTools = true;
    const ctx = newTurnContext({});
    const out = await runWithTurn(ctx, () => dispatch("tool_search", "{}"));
    expect(out).toBe("Argument error: missing required argument: 'query'");
  });

  it("refuses to run outside a turn", async () => {
    config.enableDeferredTools = true;
    const out = await dispatch("tool_search", JSON.stringify({ query: "workflow" }));
    expect(out).toBe("Error: tool_search must run inside a turn");
  });
});

describe("skill tool", () => {
  function writeSkill(name: string, description: string, body: string): void {
    const dir = path.join(config.root, ".reagent", "skills", name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`,
    );
  }

  it("loads a project skill's full body (happy path)", async () => {
    writeSkill("demo-skill", "A demo skill", "Full playbook body.");
    const out = await dispatch("skill", JSON.stringify({ name: "demo-skill" }));
    expect(out).toBe("# Skill: demo-skill\n\nA demo skill\n\nFull playbook body.");
  });

  it("returns an Argument error: string when 'name' is missing", async () => {
    const out = await dispatch("skill", "{}");
    expect(out).toBe("Argument error: missing required argument: 'name'");
  });

  it("reports unknown skill names instead of throwing", async () => {
    const out = await dispatch("skill", JSON.stringify({ name: "does-not-exist" }));
    expect(out.startsWith("Error: unknown skill 'does-not-exist'")).toBe(true);
  });
});

describe("workflow tool", () => {
  it("is disabled by default", async () => {
    const out = await dispatch("workflow", JSON.stringify({ mode: "pipeline", steps: [] }));
    expect(out.startsWith("Error: the workflow tool is disabled")).toBe(true);
  });

  it("rejects an invalid mode", async () => {
    config.enableWorkflow = true;
    const out = await dispatch(
      "workflow",
      JSON.stringify({ mode: "nope", steps: [{ agent_type: "explore", prompt: "x" }] }),
    );
    expect(out).toBe("Error: mode must be 'pipeline' or 'parallel'");
  });

  it("returns an Error: string for malformed steps instead of throwing", async () => {
    config.enableWorkflow = true;
    const out = await dispatch("workflow", JSON.stringify({ mode: "pipeline", steps: "nope" }));
    expect(out).toBe("Error: steps must be an array of {agent_type, prompt} objects");
  });

  it("rejects an unknown agent_type", async () => {
    config.enableWorkflow = true;
    const out = await dispatch(
      "workflow",
      JSON.stringify({ mode: "pipeline", steps: [{ agent_type: "bogus", prompt: "x" }] }),
    );
    expect(out).toContain("Error: unknown agent_type 'bogus'. Known:");
  });

  it("runs a single-step pipeline end to end (happy path)", async () => {
    config.enableWorkflow = true;
    vi.mocked(chat).mockImplementation(async () => textResp("step done") as never);
    const out = await dispatch(
      "workflow",
      JSON.stringify({
        mode: "pipeline",
        steps: [{ agent_type: "explore", prompt: "do the thing", title: "Step A" }],
      }),
    );
    expect(out).toContain("Workflow (pipeline) finished: 1 steps.");
    expect(out).toContain("### Step A [done]");
    expect(out).toContain("step done");
  });
});
