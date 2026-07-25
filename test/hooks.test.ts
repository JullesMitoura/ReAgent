// Lifecycle hooks: matchers, JSON output protocol, and the new events
// (UserPromptSubmit / SessionStart / SessionEnd / SubagentStart / SubagentStop /
// PostToolUseFailure). Hooks are real shell commands run against a temp project.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { config } from "../src/config.js";

vi.mock("../src/llm/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/llm/client.js")>();
  return { ...actual, chat: vi.fn(actual.chat) };
});

import { chat } from "../src/llm/client.js";
import {
  hooksConfigured,
  runPostToolUse,
  runPostToolUseFailureHooks,
  runPreToolUse,
  runSessionEndHooks,
  runSessionStartHooks,
  runStopHooks,
  runUserPromptSubmitHooks,
  type HooksFile,
} from "../src/hooks/runner.js";
import { runAgent } from "../src/agents/run.js";
import { clearAgentSessions } from "../src/agents/sessions.js";
import "../src/agents/index.js";
import { isProjectTrusted, trustProject } from "../src/trust.js";

const originalRoot = config.root;
const originalEnableSubagent = config.enableSubagent;
let project: string;

function writeHooks(hooks: HooksFile["hooks"]): void {
  fs.mkdirSync(config.stateDir, { recursive: true });
  fs.writeFileSync(path.join(config.stateDir, "hooks.json"), JSON.stringify({ hooks }));
}

function textResp(text: string): { choices: { message: { content: string; tool_calls: null } }[] } {
  return { choices: [{ message: { content: text, tool_calls: null } }] };
}

beforeEach(() => {
  project = config.setRoot(fs.mkdtempSync(path.join(os.tmpdir(), "reagent-hooks-")));
  config.autoApprove = true;
  config.contextFile = false;
  clearAgentSessions();
  // These tests deliberately write their own hooks.json and expect it to run,
  // same as a developer's own local project they already reviewed: trust it
  // up front so the security gate (untrusted hooks.json no-ops, see the
  // "hooks: untrusted project" describe block below) doesn't change their
  // meaning.
  trustProject(project);
});

afterEach(() => {
  vi.mocked(chat).mockReset();
  config.enableSubagent = originalEnableSubagent;
  config.setRoot(originalRoot);
  clearAgentSessions();
  fs.rmSync(project, { recursive: true, force: true });
});

describe("hooks: matchers", () => {
  it("legacy flat format runs for every tool", () => {
    writeHooks({ PreToolUse: [{ type: "command", command: "exit 1" }] });
    expect(runPreToolUse("bash", "{}").decision).toBe("deny");
    expect(runPreToolUse("read_file", "{}").decision).toBe("deny");
  });

  it("exact matcher only fires for that tool (case-insensitive)", () => {
    writeHooks({
      PreToolUse: [{ matcher: "BASH", hooks: [{ type: "command", command: "exit 1" }] }],
    });
    expect(runPreToolUse("bash", "{}").decision).toBe("deny");
    expect(runPreToolUse("read_file", "{}").decision).toBe("allow");
  });

  it("regex matcher fires for alternatives only", () => {
    writeHooks({
      PreToolUse: [
        { matcher: "bash|edit_file", hooks: [{ type: "command", command: "exit 1" }] },
      ],
    });
    expect(runPreToolUse("bash", "{}").decision).toBe("deny");
    expect(runPreToolUse("edit_file", "{}").decision).toBe("deny");
    expect(runPreToolUse("grep", "{}").decision).toBe("allow");
  });

  it("'*' matcher fires for all tools; flat and grouped entries can be mixed", () => {
    writeHooks({
      PreToolUse: [
        { matcher: "*", hooks: [{ type: "command", command: "exit 0" }] },
        { type: "command", command: "exit 1" },
      ],
    });
    expect(runPreToolUse("anything", "{}").decision).toBe("deny");
  });

  it("hooksConfigured recognizes the grouped format", () => {
    expect(hooksConfigured()).toBe(false);
    writeHooks({
      PostToolUse: [{ matcher: "bash", hooks: [{ type: "command", command: "true" }] }],
    });
    expect(hooksConfigured()).toBe(true);
  });
});

describe("hooks: JSON output protocol", () => {
  it("PreToolUse deny with reason (exit 0 + JSON)", () => {
    writeHooks({
      PreToolUse: [
        { type: "command", command: `echo '{"decision":"deny","reason":"nope, blocked"}'` },
      ],
    });
    const r = runPreToolUse("bash", "{}");
    expect(r.decision).toBe("deny");
    expect(r.message).toBe("nope, blocked");
  });

  it("PreToolUse ask decision is surfaced", () => {
    writeHooks({
      PreToolUse: [
        { type: "command", command: `echo '{"decision":"ask","reason":"confirm this"}'` },
      ],
    });
    const r = runPreToolUse("bash", "{}");
    expect(r.decision).toBe("ask");
    expect(r.message).toBe("confirm this");
  });

  it("PreToolUse allow carries additionalContext", () => {
    writeHooks({
      PreToolUse: [
        {
          type: "command",
          command: `echo '{"decision":"allow","additionalContext":"lint is clean"}'`,
        },
      ],
    });
    const r = runPreToolUse("bash", "{}");
    expect(r.decision).toBe("allow");
    expect(r.additionalContext).toBe("lint is clean");
  });

  it("non-JSON stdout on success is ignored", () => {
    writeHooks({ PreToolUse: [{ type: "command", command: "echo all good" }] });
    const r = runPreToolUse("bash", "{}");
    expect(r.decision).toBe("allow");
    expect(r.additionalContext).toBeUndefined();
  });

  it("exit code != 0 still denies (legacy compat), using stderr as reason", () => {
    writeHooks({ PreToolUse: [{ type: "command", command: "echo bad >&2; exit 3" }] });
    const r = runPreToolUse("bash", "{}");
    expect(r.decision).toBe("deny");
    expect(r.message).toBe("bad");
  });

  it("PostToolUse returns additionalContext", () => {
    writeHooks({
      PostToolUse: [
        { type: "command", command: `echo '{"additionalContext":"file was reformatted"}'` },
      ],
    });
    const r = runPostToolUse("write_file", "{}", "ok");
    expect(r.additionalContext).toBe("file was reformatted");
  });

  it("Stop hook can block with a reason", () => {
    writeHooks({
      Stop: [{ type: "command", command: `echo '{"decision":"block","reason":"tests not run"}'` }],
    });
    expect(runStopHooks("final answer")).toEqual({ block: true, reason: "tests not run" });
  });

  it("Stop without block decision does not block", () => {
    writeHooks({ Stop: [{ type: "command", command: "echo done" }] });
    expect(runStopHooks("final answer")).toEqual({ block: false });
  });
});

describe("hooks: new events", () => {
  it("UserPromptSubmit receives the prompt and can inject context", () => {
    const payloadFile = path.join(project, "payload.json");
    writeHooks({
      UserPromptSubmit: [
        {
          type: "command",
          command: `cat > "${payloadFile}" && echo '{"additionalContext":"remember the style guide"}'`,
        },
      ],
    });
    const r = runUserPromptSubmitHooks("please fix the bug");
    expect(r.additionalContext).toBe("remember the style guide");
    const payload = JSON.parse(fs.readFileSync(payloadFile, "utf8"));
    expect(payload.event).toBe("UserPromptSubmit");
    expect(payload.prompt).toBe("please fix the bug");
  });

  it("SessionStart / SessionEnd / PostToolUseFailure run their commands", () => {
    const logFile = path.join(project, "events.log");
    const record = {
      type: "command" as const,
      command: `{ cat; echo; } >> "${logFile}"`,
    };
    writeHooks({
      SessionStart: [record],
      SessionEnd: [record],
      PostToolUseFailure: [{ matcher: "bash", hooks: [record] }],
    });
    runSessionStartHooks("resume");
    runSessionEndHooks();
    runPostToolUseFailureHooks("bash", '{"command":"false"}', "exit 1");
    // matcher must also filter failure hooks
    runPostToolUseFailureHooks("read_file", "{}", "boom");
    const lines = fs
      .readFileSync(logFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    expect(lines.map((l) => l.event)).toEqual([
      "SessionStart",
      "SessionEnd",
      "PostToolUseFailure",
    ]);
    expect(lines[0].source).toBe("resume");
    expect(lines[2].error).toBe("exit 1");
  });

  it("SubagentStart and SubagentStop fire around a subagent run", async () => {
    config.enableSubagent = true;
    const logFile = path.join(project, "agent-events.log");
    writeHooks({
      SubagentStart: [{ type: "command", command: `{ cat; echo; } >> "${logFile}"` }],
      SubagentStop: [{ type: "command", command: `{ cat; echo; } >> "${logFile}"` }],
    });
    vi.mocked(chat).mockImplementation(async () => textResp("explored: nothing found") as never);
    const report = await runAgent({ agentType: "explore", prompt: "look around", title: "t" });
    expect(report).toContain("explored: nothing found");
    const lines = fs
      .readFileSync(logFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    expect(lines.length).toBe(2);
    expect(lines[0]).toMatchObject({
      event: "SubagentStart",
      agentType: "explore",
      prompt: "look around",
    });
    expect(lines[1]).toMatchObject({
      event: "SubagentStop",
      agentType: "explore",
      report: "explored: nothing found",
    });
  });
});

describe("hooks: untrusted project (security gate)", () => {
  // This project is intentionally NOT trusted (the beforeEach above already
  // called trustProject(project); undo that here to test the untrusted path).
  beforeEach(() => {
    fs.rmSync(path.join(config.stateDir, "trusted"), { force: true });
  });

  it("a hooks.json in an untrusted project never runs: PreToolUse stays 'allow'", () => {
    expect(isProjectTrusted(project)).toBe(false);
    writeHooks({ PreToolUse: [{ type: "command", command: "exit 1" }] });
    // Without the trust gate this would deny (see the "legacy flat format"
    // test above, same hooks.json, same command, only trust differs).
    expect(runPreToolUse("bash", "{}").decision).toBe("allow");
  });

  it("hooksConfigured() reports false for an untrusted project's hooks.json", () => {
    writeHooks({ PostToolUse: [{ matcher: "bash", hooks: [{ type: "command", command: "true" }] }] });
    expect(hooksConfigured()).toBe(false);
  });

  it("SessionStart/Stop/PostToolUseFailure hooks also no-op while untrusted", () => {
    const logFile = path.join(project, "should-not-exist.log");
    const record = { type: "command" as const, command: `echo hit >> "${logFile}"` };
    writeHooks({
      SessionStart: [record],
      Stop: [{ type: "command", command: `echo '{"decision":"block","reason":"nope"}'` }],
    });
    runSessionStartHooks("startup");
    expect(runStopHooks("final answer")).toEqual({ block: false });
    expect(fs.existsSync(logFile)).toBe(false);
  });

  it("trusting the project makes the SAME hooks.json start running again", () => {
    writeHooks({ PreToolUse: [{ type: "command", command: "exit 1" }] });
    expect(runPreToolUse("bash", "{}").decision).toBe("allow"); // untrusted: no-op
    trustProject(project);
    expect(runPreToolUse("bash", "{}").decision).toBe("deny"); // trusted: runs for real
  });
});

describe("hooks: subprocess env is scrubbed (no API keys leak into hook commands)", () => {
  const secretVar = "AZURE_OPENAI_KEY"; // exact key env-scrub.ts always removes
  const savedSecret = process.env[secretVar];

  beforeEach(() => {
    process.env[secretVar] = "super-secret-value";
  });

  afterEach(() => {
    if (savedSecret === undefined) delete process.env[secretVar];
    else process.env[secretVar] = savedSecret;
  });

  it("a PreToolUse hook cannot see AZURE_OPENAI_KEY from the parent process", () => {
    writeHooks({
      PreToolUse: [
        {
          type: "command",
          command: `if [ -n "$${secretVar}" ]; then echo '{"decision":"deny","reason":"leaked"}'; fi`,
        },
      ],
    });
    // If runCommand() ever regresses to `env: { ...process.env, ... }`, the
    // hook sees the secret and denies with "leaked".
    expect(runPreToolUse("bash", "{}").decision).toBe("allow");
  });
});
