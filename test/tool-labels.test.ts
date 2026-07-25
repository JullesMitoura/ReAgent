import { describe, expect, it } from "vitest";

import { toolLabel, toolTechnicalDetail } from "../src/cli/tool-labels.js";

describe("tool-labels", () => {
  it("test_friendly_labels_for_common_tools", () => {
    expect(toolLabel("read_file", '{"path":"src/app.ts"}')).toBe("Reading src/app.ts");
    expect(toolLabel("write_file", '{"path":"game.html","content":"..."}')).toBe("Writing game.html");
    expect(toolLabel("edit_file", '{"path":"a.ts"}')).toBe("Editing a.ts");
    expect(toolLabel("multi_edit", '{"path":"a.ts","edits":[{},{}]}')).toBe("Editing a.ts (2 changes)");
    expect(toolLabel("delete_file", '{"path":"old.ts"}')).toBe("Deleting old.ts");
    expect(toolLabel("list_dir", '{"path":"src"}')).toBe("Listing src");
    expect(toolLabel("list_dir", "{}")).toBe("Listing .");
    expect(toolLabel("glob", '{"pattern":"**/*.ts"}')).toBe("Searching for files matching **/*.ts");
    expect(toolLabel("grep", '{"pattern":"TODO","path":"src"}')).toBe('Searching for "TODO" in src');
    expect(toolLabel("grep", '{"pattern":"TODO"}')).toBe('Searching for "TODO"');
  });

  it("test_bash_prefers_description_over_raw_command", () => {
    expect(toolLabel("bash", '{"command":"npm test","description":"Run the test suite"}')).toBe(
      "Running: Run the test suite",
    );
    expect(toolLabel("bash", '{"command":"npm test"}')).toBe("Running: npm test");
    expect(toolLabel("bash", "{}")).toBe("Running a command");
  });

  it("test_agent_and_delegation_tools", () => {
    expect(toolLabel("agent", '{"subagent_type":"explore","description":"map the auth flow"}')).toBe(
      "Launching explore agent: map the auth flow",
    );
    expect(toolLabel("agent", "{}")).toBe("Launching an agent");
    expect(toolLabel("parallel_agents", '{"tasks":[{},{},{}]}')).toBe("Launching 3 parallel agents");
    expect(toolLabel("send_message", '{"to":"agent-abc"}')).toBe("Continuing agent agent-abc");
  });

  it("test_unknown_tool_falls_back_to_generic_label", () => {
    expect(toolLabel("some_future_tool", "{}")).toBe("Running some_future_tool");
  });

  it("test_survives_truncated_mid_stream_json", () => {
    // tool_start emits at most 200 chars of the arguments mid-stream, so this
    // is not always valid JSON (see agent/query.ts's argsPreviewLimit()).
    const truncated = '{"path":"src/very/long/path/that/keeps/going.ts","content":"export function';
    expect(() => toolLabel("write_file", truncated)).not.toThrow();
    expect(toolLabel("write_file", truncated)).toBe("Writing src/very/long/path/that/keeps/going.ts");
  });

  it("test_survives_completely_malformed_args", () => {
    expect(() => toolLabel("read_file", "not json at all")).not.toThrow();
    expect(toolLabel("read_file", "not json at all")).toBe("Reading a file");
    expect(toolLabel("grep", "")).toBe("Searching file contents");
  });

  it("test_technical_detail_summarizes_or_shows_full", () => {
    const args = '{"path":"a.ts"}';
    expect(toolTechnicalDetail("read_file", args, false)).toBe(`read_file(${args})`);
    const long = "x".repeat(200);
    const summarized = toolTechnicalDetail("bash", long, false);
    expect(summarized.length).toBeLessThan(long.length);
    expect(toolTechnicalDetail("bash", long, true)).toBe(`bash(${long})`);
  });
});
