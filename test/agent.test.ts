// 1:1 mirror of tests/test_agent.py (7 tests): tail repair (_sanitize) and
// usage tracking (prefix-cache tokens).
//
// The Python `project` fixture becomes a beforeEach with fs.mkdtempSync (tmp
// root + autoApprove + contextFile off). The Python private methods (_sanitize,
// _track_usage) are public in the port (sanitize, trackUsage).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Agent } from "../src/agent.js";
import { config } from "../src/config.js";
import { Session } from "../src/session.js";
import type { ChatMessage } from "../src/types.js";

function agentWith(messages: ChatMessage[]): Agent {
  const s = Session.new();
  s.messages = messages;
  return new Agent(s);
}

const SYS: ChatMessage = { role: "system", content: "sys" };
const USER: ChatMessage = { role: "user", content: "hi" };

function assistantWithCalls(n: number): ChatMessage {
  const tool_calls = [];
  for (let i = 0; i < n; i++) {
    tool_calls.push({
      id: `c${i}`,
      type: "function" as const,
      function: { name: "list_dir", arguments: "{}" },
    });
  }
  return { role: "assistant", content: "", tool_calls };
}

const originalRoot = config.root;
let project: string;

beforeEach(() => {
  project = config.setRoot(fs.mkdtempSync(path.join(os.tmpdir(), "reagent-agent-")));
  config.autoApprove = true;
  config.contextFile = false;
});

afterEach(() => {
  config.setRoot(originalRoot);
  fs.rmSync(project, { recursive: true, force: true });
});

describe("agent", () => {
  it("test_sanitize_repairs_dangling_tool_calls", () => {
    // calls without any response get "aborted by user" stubs (repairs, does not delete)
    const agent = agentWith([SYS, USER, assistantWithCalls(2)]);
    agent.sanitize();
    expect(agent.messages[2]).toEqual(assistantWithCalls(2)); // assistant preserved
    expect(agent.messages[3]).toEqual({
      role: "tool",
      tool_call_id: "c0",
      content: "aborted by user",
    });
    expect(agent.messages[4]).toEqual({
      role: "tool",
      tool_call_id: "c1",
      content: "aborted by user",
    });
    expect(agent.messages.length).toBe(5);
  });

  it("test_sanitize_repairs_partial_tool_responses", () => {
    // the existing response stays; only the call without a response gets the stub
    const done: ChatMessage = { role: "tool", tool_call_id: "c0", content: "ok" };
    const agent = agentWith([SYS, USER, assistantWithCalls(2), done]);
    agent.sanitize();
    expect(agent.messages[3]).toEqual(done);
    expect(agent.messages[agent.messages.length - 1]).toEqual({
      role: "tool",
      tool_call_id: "c1",
      content: "aborted by user",
    });
    expect(agent.messages.length).toBe(5);
  });

  it("test_sanitize_drops_orphan_tool_responses", () => {
    // a 'tool' whose id does not belong to the calls is orphan: dropped; the call without a response gets a stub
    const agent = agentWith([
      SYS,
      USER,
      assistantWithCalls(2),
      { role: "tool", tool_call_id: "c0", content: "ok" },
      { role: "tool", tool_call_id: "zz", content: "orphan" },
    ]);
    agent.sanitize();
    const ids = agent.messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id);
    expect(ids).toEqual(["c0", "c1"]);
    expect(agent.messages[agent.messages.length - 1]!.content).toBe("aborted by user");
  });

  it("test_sanitize_keeps_complete_pairs", () => {
    const msgs: ChatMessage[] = [
      SYS,
      USER,
      assistantWithCalls(2),
      { role: "tool", tool_call_id: "c0", content: "ok" },
      { role: "tool", tool_call_id: "c1", content: "ok" },
    ];
    const agent = agentWith([...msgs]);
    agent.sanitize();
    expect(agent.messages.length).toBe(msgs.length);
  });

  it("test_sanitize_keeps_plain_history", () => {
    const msgs: ChatMessage[] = [SYS, USER, { role: "assistant", content: "answer" }];
    const agent = agentWith([...msgs]);
    agent.sanitize();
    expect(agent.messages.length).toBe(msgs.length);
  });

  // --- usage tracking (prefix-cache tokens) -----------------------------------

  it("test_track_usage_accumulates_cached_tokens", () => {
    const agent = agentWith([SYS, USER]);
    agent.trackUsage({
      prompt_tokens: 1000,
      completion_tokens: 50,
      prompt_tokens_details: { cached_tokens: 800 },
    });
    agent.trackUsage({
      prompt_tokens: 1200,
      completion_tokens: 60,
      prompt_tokens_details: { cached_tokens: 1000 },
    });
    const u = agent.session.usage;
    expect(u.prompt_tokens).toBe(2200);
    expect(u.cached_prompt_tokens).toBe(1800);
    expect(u.last_prompt_tokens).toBe(1200);
  });

  it("test_track_usage_without_cache_details_is_safe", () => {
    // providers/versions without prompt_tokens_details must not break tracking
    const agent = agentWith([SYS, USER]);
    agent.trackUsage({ prompt_tokens: 500, completion_tokens: 10 });
    const u = agent.session.usage;
    expect(u.prompt_tokens).toBe(500);
    expect("cached_prompt_tokens" in u).toBe(false);
  });
});
