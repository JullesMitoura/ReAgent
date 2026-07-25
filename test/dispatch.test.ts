// Mirror of tests/test_dispatch.py: dispatch contract (never throws), dynamic
// schema gating, and name repair. Test names 1:1 with Python.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { config } from "../src/config.js";
import { mapLimit } from "../src/lib/pool.js";
import { getLogger, RootLogger } from "../src/logs.js";
import { REGISTRY, activeSchemas, dispatch, dispatchParallel, _setMaxToolOutput } from "../src/tools/index.js";
import type { ToolCall } from "../src/types.js";

vi.mock("../src/lib/pool.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/pool.js")>();
  return { ...actual, mapLimit: vi.fn(actual.mapLimit) };
});

const originalRoot = config.root;
let project: string;

beforeEach(() => {
  project = config.setRoot(fs.mkdtempSync(path.join(os.tmpdir(), "reagent-dispatch-")));
  config.autoApprove = true;
  config.contextFile = false;
});

afterEach(() => {
  _setMaxToolOutput(null);
  config.setRoot(originalRoot);
  fs.rmSync(project, { recursive: true, force: true });
});

describe("dispatch", () => {
  it("test_unknown_tool", async () => {
    expect(await dispatch("nope", "{}")).toBe("Error: unknown tool 'nope'");
  });

  it("test_invalid_json_arguments", async () => {
    expect(await dispatch("list_dir", "{broken")).toContain("not valid JSON");
  });

  it("test_output_truncation", async () => {
    // output above the cap: preview + spill to .reagent/truncations (not lost)
    _setMaxToolOutput(40);
    fs.writeFileSync(path.join(project, "big.txt"), "x".repeat(500));
    const out = await dispatch("read_file", '{"path": "big.txt"}');
    expect(out).toContain("full output saved to");
  });

  it("test_grep_and_glob", async () => {
    fs.writeFileSync(path.join(project, "one.py"), "needle = 1\n");
    fs.writeFileSync(path.join(project, "two.txt"), "no match\n");
    expect(await dispatch("grep", '{"pattern": "needle", "include": "*.py"}')).toContain("one.py:1");
    const out = await dispatch("glob", '{"pattern": "*.py"}');
    expect(out).toContain("one.py");
    expect(out).not.toContain("two.txt");
  });

  it("test_todo_validation", async () => {
    expect(await dispatch("todowrite", '{"todos": [{"content": "x", "status": "wrong"}]}')).toContain(
      "invalid status",
    );
    const ok = await dispatch("todowrite", '{"todos": [{"content": "x", "status": "completed"}]}');
    expect(ok).toContain("1/1 completed");
  });

  it("test_question_single_option_auto_proceeds", async () => {
    const out = await dispatch("question", '{"question": "pick one", "options": ["a"]}');
    expect(out).toContain("at least two distinct options");
    expect(out).toContain("proceeding with");
  });

  it("test_question_non_interactive", async () => {
    const out = await dispatch("question", '{"question": "pick one"}');
    expect(out).toContain("non-interactive");
  });

  it("test_webfetch_disabled_by_default", async () => {
    // always registered (dynamic gating), but execution self-protects and the
    // schema is not offered to the model when disabled (see active_schemas)
    const result = await dispatch("webfetch", '{"url": "https://example.com"}');
    expect(result.startsWith("Error")).toBe(true);
    expect(result).toContain("disabled");
  });

  it("test_webfetch_schema_not_offered_when_disabled", () => {
    const names = new Set(
      activeSchemas().map((s) => (s as { function: { name: string } }).function.name),
    );
    expect(names.has("webfetch")).toBe(false);
  });

  it("test_bash_schema_offers_description_and_run_in_background", () => {
    const bashSchema = activeSchemas().find(
      (s) => (s as { function: { name: string } }).function.name === "bash",
    ) as { function: { parameters: { properties: Record<string, unknown> } } };
    const props = bashSchema.function.parameters.properties;
    expect(props["description"]).toBeDefined();
    expect(props["run_in_background"]).toBeDefined();
  });

  it("test_task_tools_offered_alongside_bash", () => {
    const names = new Set(
      activeSchemas().map((s) => (s as { function: { name: string } }).function.name),
    );
    expect(names.has("bash")).toBe(true);
    expect(names.has("task_output")).toBe(true);
    expect(names.has("task_stop")).toBe(true);
  });

  // Best practice (does not exist in Python): schema vs REGISTRY parity. Every name
  // offered by active_schemas must exist in REGISTRY and without duplicates.
  it("test_active_schemas_match_registry", () => {
    config.enableWebfetch = true;
    config.enableSubagent = true;
    config.enableParallel = true;
    config.enableExecSessions = true;
    const names = activeSchemas().map((s) => (s as { function: { name: string } }).function.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(Object.prototype.hasOwnProperty.call(REGISTRY, name)).toBe(true);
    }
  });

  // Traceability: dispatch() must log something about a successful tool
  // result (name + output length) so post-hoc debugging does not depend only
  // on query.ts's call-args/failure logging.
  it("test_dispatch_logs_tool_name_and_output_length_on_success", async () => {
    const root = getLogger("reagent") as RootLogger;
    const savedLevel = root.level;
    root.level = 10; // DEBUG: let an info-level line through regardless of env
    const lines: string[] = [];
    const handler = { emit: (line: string) => lines.push(line) };
    root.handlers.push(handler);
    try {
      fs.writeFileSync(path.join(project, "log-me.txt"), "secret-content\n");
      await dispatch("read_file", '{"path": "log-me.txt"}');
    } finally {
      root.handlers.pop();
      root.level = savedLevel;
    }
    const line = lines.find((l) => l.includes("read_file"));
    expect(line, `no log line mentioned read_file; got: ${JSON.stringify(lines)}`).toBeDefined();
    expect(line).toContain("chars"); // logs the output LENGTH, never the content
    expect(lines.join("\n")).not.toContain("secret-content");
  });

  // dispatchParallel is the path the model actually uses to fan out several
  // "agent" calls in one round (its own tool description encourages this); it
  // must respect maxAgentConcurrency for that batch, not the (usually larger)
  // maxToolConcurrency, or the "at most N sub-agents at once" cap is bypassed.
  describe("dispatchParallel agent concurrency cap", () => {
    it("test_agent_batch_is_capped_by_max_agent_concurrency", async () => {
      config.maxToolConcurrency = 8;
      config.maxAgentConcurrency = 2;
      const toolCalls: ToolCall[] = [
        { id: "a1", type: "function", function: { name: "agent", arguments: "{}" } },
        { id: "a2", type: "function", function: { name: "agent", arguments: "{}" } },
      ];
      await dispatchParallel(toolCalls);
      const call = vi.mocked(mapLimit).mock.calls.at(-1);
      expect(call?.[1]).toBe(2);
    });

    it("test_non_agent_batch_still_uses_max_tool_concurrency", async () => {
      config.maxToolConcurrency = 8;
      config.maxAgentConcurrency = 2;
      const toolCalls: ToolCall[] = [
        { id: "r1", type: "function", function: { name: "list_dir", arguments: "{}" } },
      ];
      await dispatchParallel(toolCalls);
      const call = vi.mocked(mapLimit).mock.calls.at(-1);
      expect(call?.[1]).toBe(8);
    });
  });
});
