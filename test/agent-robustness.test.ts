// 1:1 mirror of tests/test_agent_robustness.py (17 tests): resilient
// compaction (sanitize before summarizing, empty summary is non-destructive,
// incremental pruning on context_length, fallback to hard truncate) and the
// stream consumption (retry without finish_reason/usage, drop of tool calls
// truncated by finish=length, fatal content_filter, pre-turn checks).
//
// No network: the monkeypatch of src.llm.chat becomes a vi.mock of ../src/llm/client.js.
// Summary responses are NON-streaming ({choices:[{message:{content}}]}); the
// loop ones are STREAMING (iterable arrays). build_system_prompt is "sys" (hermetic
// and light). context_length errors use a real 400 APIError from the openai package.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APIError } from "openai";

vi.mock("../src/system-prompt.js", () => ({ buildSystemPrompt: () => "sys" }));

vi.mock("../src/llm/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/llm/client.js")>();
  return { ...actual, chat: vi.fn(actual.chat) };
});

import { Agent, _testHooks } from "../src/agent.js";
import { config } from "../src/config.js";
import { SUMMARY_MARKER, estimateTokens, packMessages } from "../src/context.js";
import { chat } from "../src/llm/client.js";
import { ContentFilterError, ContextWindowExceededError } from "../src/llm/errors.js";
import { Session } from "../src/session.js";
import type { ChatMessage } from "../src/types.js";

const SYS: ChatMessage = { role: "system", content: "sys" };
const USER: ChatMessage = { role: "user", content: "hi" };

function agentWith(messages: ChatMessage[]): Agent {
  const s = Session.new();
  s.messages = messages;
  return new Agent(s);
}

function assistantWithCalls(ids: string[]): ChatMessage {
  return {
    role: "assistant",
    content: "",
    tool_calls: ids.map((i) => ({
      id: i,
      type: "function" as const,
      function: { name: "list_dir", arguments: "{}" },
    })),
  };
}

/** Every 'tool' must follow a prior assistant(tool_calls) that opened the id. */
function noOrphanTools(messages: ChatMessage[]): boolean {
  let openIds = new Set<string>();
  for (const m of messages) {
    if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
      openIds = new Set(m.tool_calls.map((tc) => tc.id));
    } else if (m.role === "tool") {
      const id = m.tool_call_id;
      if (id === undefined || !openIds.has(id)) return false;
      openIds.delete(id);
    } else {
      openIds = new Set();
    }
  }
  return true;
}

// --- fakes: NON-streaming response (summary) and context_length error --------
function fakeResponse(content: string): unknown {
  return { choices: [{ message: { content } }] };
}

function ctxError(): APIError {
  const err = new APIError(
    400,
    { error: { code: "context_length_exceeded" } },
    "context_length_exceeded",
    new Headers(),
  );
  err.message = "context_length_exceeded";
  return err;
}

// --- fakes: STREAMING (shape consumed by streamCompletion) -------------------
interface ToolCallDelta {
  index: number;
  id?: string;
  function: { name?: string; arguments?: string };
}
function chunk(opts: {
  content?: string | null;
  toolCall?: ToolCallDelta;
  finishReason?: string | null;
}): unknown {
  const delta = {
    content: opts.content ?? null,
    tool_calls: opts.toolCall ? [opts.toolCall] : null,
  };
  return { choices: [{ delta, finish_reason: opts.finishReason ?? null }], usage: null };
}
function usageChunk(prompt = 10, completion = 3): unknown {
  return { choices: [], usage: { prompt_tokens: prompt, completion_tokens: completion } };
}
function finalStream(text = "done"): unknown[] {
  return [chunk({ content: text, finishReason: "stop" }), usageChunk()];
}

function longHistory(): ChatMessage[] {
  const msgs: ChatMessage[] = [SYS, { role: "user", content: "start" }];
  for (let i = 0; i < 30; i++) {
    msgs.push(assistantWithCalls([`t${i}`]));
    msgs.push({ role: "tool", tool_call_id: `t${i}`, content: "ok" });
    msgs.push({ role: "user", content: `u${i}` });
  }
  return msgs;
}

const originalRoot = config.root;
let project: string;

beforeEach(() => {
  project = config.setRoot(fs.mkdtempSync(path.join(os.tmpdir(), "reagent-robust-")));
  config.autoApprove = true;
  config.contextFile = false;
  _testHooks.sleep = async () => {};
});

afterEach(() => {
  vi.mocked(chat).mockReset();
  config.setRoot(originalRoot);
  fs.rmSync(project, { recursive: true, force: true });
});

describe("agent-robustness", () => {
  // (a) a dangling assistant(tool_calls) tail does not block /compact -----------
  it("test_compact_sanitizes_dangling_tail_before_summarizing", async () => {
    const captured: { messages?: ChatMessage[] } = {};
    vi.mocked(chat).mockImplementation(async (messages) => {
      captured.messages = messages as ChatMessage[];
      return fakeResponse("DENSE SUMMARY") as never;
    });

    const agent = agentWith([
      SYS,
      USER,
      { role: "assistant", content: "prev answer" },
      { role: "user", content: "again" },
      assistantWithCalls(["c0", "c1"]), // dangling tail, no 'tool' responses
    ]);

    await agent.compact(); // must not raise

    // The request sent to the model has valid history: every call has a response.
    expect(noOrphanTools(captured.messages!)).toBe(true);
    expect(agent.messages[0]!.role).toBe("system");
    const summaryIdx = agent.messages.findIndex(
      (m) => m.role === "user" && String(m.content).startsWith(SUMMARY_MARKER),
    );
    expect(String(agent.messages[summaryIdx]!.content)).toContain("DENSE SUMMARY");
    expect(agent.messages[summaryIdx + 1]!.role).toBe("assistant"); // ack
    const preserved = agent.messages
      .slice(1, summaryIdx)
      .filter((m) => m.role === "user")
      .map((m) => m.content);
    expect(preserved).toEqual(["hi", "again"]);
    expect(noOrphanTools(agent.messages)).toBe(true);
  });

  // (b) an empty summary must not destroy the history --------------------------
  it("test_compact_empty_summary_leaves_history_unchanged", async () => {
    vi.mocked(chat).mockImplementation(async () => fakeResponse("") as never);

    const original: ChatMessage[] = [
      SYS,
      USER,
      { role: "assistant", content: "answer" },
      { role: "user", content: "next" },
    ];
    const agent = agentWith(structuredClone(original));
    const before = structuredClone(agent.messages);

    await agent.compact();

    expect(agent.messages).toEqual(before);
  });

  // (b') a whitespace-only summary is also treated as empty --------------------
  it("test_compact_whitespace_summary_leaves_history_unchanged", async () => {
    vi.mocked(chat).mockImplementation(async () => fakeResponse("   \n\t  ") as never);

    const agent = agentWith([
      SYS,
      USER,
      { role: "assistant", content: "answer" },
      { role: "user", content: "next" },
    ]);
    const before = structuredClone(agent.messages);

    await agent.compact();

    expect(agent.messages).toEqual(before);
  });

  // (c) a failing summary falls back to deterministic truncation ---------------
  it("test_compact_failure_falls_back_to_hard_truncation", async () => {
    vi.mocked(chat).mockImplementation(async () => {
      throw new Error("context_length_exceeded"); // generic error, not APIError
    });

    const msgs: ChatMessage[] = [SYS, { role: "user", content: "start" }];
    for (let i = 0; i < 30; i++) {
      msgs.push(assistantWithCalls([`t${i}`]));
      msgs.push({ role: "tool", tool_call_id: `t${i}`, content: "ok" });
      msgs.push({ role: "user", content: `u${i}` });
    }
    const agent = agentWith(msgs);

    await agent.compact(); // must not raise; must truncate

    const kept = agent.messages;
    expect(kept[0]).toEqual(SYS); // system preserved
    expect(kept.length).toBeLessThanOrEqual(21); // system + ~20 recent
    expect(kept.length).toBeLessThan(msgs.length); // actually shortened
    expect(noOrphanTools(kept)).toBe(true); // no orphan 'tool'
    expect(kept[kept.length - 1]!.content).toBe("u29"); // most recent tail kept
  });

  // (c') hardTruncate advances the boundary when it would land on an orphan 'tool' ---
  it("test_hard_truncate_advances_past_orphan_tool_boundary", () => {
    const agent = agentWith([
      SYS,
      { role: "user", content: "u0" },
      assistantWithCalls(["a", "b"]),
      { role: "tool", tool_call_id: "a", content: "ok" },
      { role: "tool", tool_call_id: "b", content: "ok" },
      { role: "user", content: "u1" },
      { role: "assistant", content: "done" },
    ]);

    agent.hardTruncate(3);

    const kept = agent.messages;
    expect(kept[0]).toEqual(SYS);
    expect(noOrphanTools(kept)).toBe(true);
    expect(kept.map((m) => m.role)).toEqual(["system", "user", "assistant"]);
    expect(kept[1]!.content).toBe("u1");
  });

  // (c'') a few giant messages also shrink (cut by budget) ---------------------
  it("test_hard_truncate_cuts_few_giant_messages_by_budget", () => {
    const big = "X".repeat(20_000); // ~5k estimated tokens per message
    const msgs: ChatMessage[] = [SYS];
    for (let i = 0; i < 8; i++) {
      const role = i % 2 === 0 ? "user" : "assistant";
      msgs.push({ role, content: `m${i} ${big}` });
    }
    const agent = agentWith(msgs);

    agent.hardTruncate(undefined, 12_000);

    const kept = agent.messages;
    expect(kept[0]).toEqual(SYS);
    expect(kept.length).toBeLessThan(msgs.length); // the count-based early-return would keep everything
    expect(String(kept[kept.length - 1]!.content).startsWith("m7")).toBe(true);
    expect(noOrphanTools(kept)).toBe(true);
    expect(estimateTokens(kept.slice(1))).toBeLessThanOrEqual(12_000); // tail fits the budget
  });

  // (c''') after the hard truncate, last_prompt_tokens reflects the real estimate ---
  it("test_hard_truncate_records_estimated_prompt_tokens", () => {
    const msgs: ChatMessage[] = [SYS];
    for (let i = 0; i < 30; i++) {
      msgs.push({ role: i % 2 === 0 ? "user" : "assistant", content: "y".repeat(8000) });
    }
    const agent = agentWith(msgs);

    agent.hardTruncate();

    const tokens = agent.session.usage.last_prompt_tokens;
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBe(estimateTokens(packMessages(agent.messages)));
  });

  // --- finish_reason: truncated stream, token ceiling and content filter ------

  it("test_stream_without_finish_reason_or_usage_retries", async () => {
    let n = 0;
    vi.mocked(chat).mockImplementation(async () => {
      n += 1;
      if (n === 1) return [chunk({ content: "partial text" })] as never; // no finish_reason nor usage
      return finalStream("done") as never;
    });

    const agent = agentWith([SYS]);
    const events: { type: string; text?: string }[] = [];
    const result = await agent.runEvents("go", (ev) => events.push(ev));

    expect(result).toBe("done");
    expect(n).toBe(2);
    expect(
      agent.messages.some((m) => m.role === "assistant" && m.content === "partial text"),
    ).toBe(true);
    expect(
      events.some((e) => e.type === "status" && (e.text ?? "").includes("retrying")),
    ).toBe(true);
  });

  it("test_finish_length_drops_truncated_tool_calls", async () => {
    // finish_reason=length with truncated arguments (invalid JSON): the call is
    // dropped and the turn ends normally, with a clear status.
    vi.mocked(chat).mockImplementation(async () => {
      const tc = { index: 0, id: "t0", function: { name: "list_dir", arguments: '{"pa' } };
      return [chunk({ toolCall: tc }), chunk({ finishReason: "length" }), usageChunk()] as never;
    });

    const agent = agentWith([SYS]);
    const events: { type: string; text?: string }[] = [];
    await agent.runEvents("go", (ev) => events.push(ev));

    expect(
      agent.messages.some((m) => Array.isArray(m.tool_calls) && m.tool_calls.length > 0),
    ).toBe(false); // invalid call dropped
    const statuses = events.filter((e) => e.type === "status").map((e) => e.text);
    expect(statuses).toContain("response truncated by token limit");
  });

  it("test_finish_content_filter_raises_with_clear_status", async () => {
    vi.mocked(chat).mockImplementation(
      async () => [chunk({ content: "hm", finishReason: "content_filter" }), usageChunk()] as never,
    );

    const agent = agentWith([SYS]);
    const events: { type: string; text?: string }[] = [];
    await expect(agent.runEvents("go", (ev) => events.push(ev))).rejects.toThrow(ContentFilterError);

    const statuses = events.filter((e) => e.type === "status").map((e) => e.text);
    expect(statuses).toContain("response blocked by content filter");
  });

  // --- pre-turn check: history estimate + new input ---------------------------

  it("test_preturn_giant_input_triggers_compact_before_model_call", async () => {
    config.compactThreshold = 100;
    vi.mocked(chat).mockImplementation(async () => finalStream("ok") as never);

    const agent = agentWith([SYS, USER, { role: "assistant", content: "prev" }]);
    agent.session.usage.last_prompt_tokens = 0;
    const giant = "z".repeat(4000); // ~1000 estimated tokens, well above the threshold

    const seen: number[] = [];
    vi.spyOn(agent, "compact").mockImplementation(async () => {
      // compact runs BEFORE the new message enters the history
      expect(agent.messages.every((m) => m.content !== giant)).toBe(true);
      seen.push(agent.messages.length);
    });

    await agent.runEvents(giant, () => {});

    expect(seen.length).toBeGreaterThan(0); // compact fired due to the new input
  });

  it("test_preturn_estimate_covers_stale_last_prompt_tokens", async () => {
    // last_prompt_tokens=0 (stale, post hard-truncate) but large history:
    // the estimate triggers compaction anyway.
    config.compactThreshold = 100;
    vi.mocked(chat).mockImplementation(async () => finalStream("ok") as never);

    const agent = agentWith([SYS, USER, { role: "assistant", content: "B".repeat(4000) }]);
    agent.session.usage.last_prompt_tokens = 0;

    const called: boolean[] = [];
    vi.spyOn(agent, "compact").mockImplementation(async () => {
      called.push(true);
    });

    await agent.runEvents("small", () => {});

    expect(called.length).toBeGreaterThan(0);
  });

  // --- recovery from context_length_exceeded within the turn ------------------

  it("test_context_length_error_compacts_and_retries", async () => {
    let n = 0;
    vi.mocked(chat).mockImplementation(async () => {
      n += 1;
      if (n === 1) throw ctxError();
      return finalStream("recovered") as never;
    });

    const agent = agentWith([SYS]);
    const compacts: boolean[] = [];
    vi.spyOn(agent, "compact").mockImplementation(async () => {
      compacts.push(true);
    });

    const events: { type: string; text?: string }[] = [];
    const result = await agent.runEvents("go", (ev) => events.push(ev));

    expect(result).toBe("recovered");
    expect(compacts).toEqual([true]); // compact called exactly once
    expect(
      events.some((e) => e.type === "status" && (e.text ?? "").includes("compacting and retrying")),
    ).toBe(true);
  });

  it("test_context_length_error_persists_forced_compaction_state", async () => {
    vi.mocked(chat).mockImplementation(async () => {
      throw ctxError();
    });

    const agent = agentWith([SYS]);
    vi.spyOn(agent, "compact").mockImplementation(async () => {}); // compacting "does not help"

    await expect(agent.runEvents("go", () => {})).rejects.toThrow(ContextWindowExceededError);

    // forces compaction on the next turn (the finally saved this usage)
    expect(agent.session.usage.last_prompt_tokens).toBe(config.compactThreshold + 1);
  });

  // --- compact: incremental pruning when the summary itself overflows the window ---

  it("test_compact_context_length_prunes_head_and_retries", async () => {
    const chatCalls: number[] = [];
    vi.mocked(chat).mockImplementation(async (messages) => {
      chatCalls.push((messages as ChatMessage[]).length);
      if ((messages as ChatMessage[]).length > 50) throw ctxError();
      return fakeResponse("PRUNED SUMMARY") as never;
    });

    const agent = agentWith(longHistory());
    await agent.compact();

    const joined = agent.messages.map((m) => String(m.content ?? "")).join("");
    expect(joined).toContain("PRUNED SUMMARY"); // summary, not hard truncate
    expect(joined).toContain(SUMMARY_MARKER);
    expect(noOrphanTools(agent.messages)).toBe(true); // pruning left no orphan 'tool'
    expect(chatCalls.length).toBeGreaterThanOrEqual(2); // there was pruning + retry
  });

  it("test_compact_persistent_context_length_falls_back_to_hard_truncate", async () => {
    const chatCalls: number[] = [];
    vi.mocked(chat).mockImplementation(async () => {
      chatCalls.push(1);
      throw ctxError();
    });

    const msgs = longHistory();
    const agent = agentWith(msgs);
    await agent.compact();

    expect(chatCalls.length).toBeLessThanOrEqual(3); // at most 3 summary attempts
    const kept = agent.messages;
    expect(kept[0]).toEqual(SYS);
    expect(kept.length).toBeLessThan(msgs.length); // fell back to the hard truncate
    expect(noOrphanTools(kept)).toBe(true);
    expect(kept[kept.length - 1]!.content).toBe("u29");
  });

  // --- compact: user messages preserved verbatim ------------------------------

  it("test_compact_preserves_recent_user_messages_verbatim", async () => {
    vi.mocked(chat).mockImplementation(async () => fakeResponse("FRESH SUMMARY") as never);
    config.compactKeepLast = 2;

    const giant = "G".repeat(50_000); // above the preservation budget (~10k tokens)
    const msgs: ChatMessage[] = [
      SYS,
      { role: "user", content: giant },
      { role: "assistant", content: "worked" },
      { role: "user", content: `${SUMMARY_MARKER}\n\nold summary` },
      { role: "assistant", content: "ack old" },
      { role: "user", content: "first ask" },
      { role: "assistant", content: "done 1" },
      { role: "user", content: "second ask" },
      { role: "assistant", content: "done 2" },
    ];
    const agent = agentWith(msgs);
    await agent.compact();

    const out = agent.messages;
    const summaryIdx = out.findIndex(
      (m) =>
        m.role === "user" &&
        String(m.content).startsWith(SUMMARY_MARKER) &&
        String(m.content).includes("FRESH SUMMARY"),
    );
    // Codex-style handoff inside the summary message
    expect(String(out[summaryIdx]!.content)).toContain("do not repeat or redo");
    // recent users verbatim, in chronological order, between the system and the summary
    const preserved = out
      .slice(1, summaryIdx)
      .filter((m) => m.role === "user")
      .map((m) => String(m.content));
    expect(preserved[preserved.length - 1]).toBe("first ask");
    // the giant one came truncated by headTail, with the omission marker
    expect(preserved[0]).toContain("chars omitted");
    expect(preserved[0]!.startsWith("G".repeat(100))).toBe(true);
    // the previous summary is not re-preserved
    expect(preserved.some((c) => c.includes("old summary"))).toBe(false);
    // recent tail intact after the ack
    expect(out.slice(-2)).toEqual(msgs.slice(-2));
  });
});
