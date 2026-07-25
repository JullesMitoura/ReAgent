// 1:1 mirror of tests/test_context.py: context packing.
// Policy (aligned with opencode's prune()): last KEEP_TURNS turns
// intact; beyond them, the most recent results preserved up to
// PROTECT_TOKENS; only trims if it recovers >= PRUNE_MINIMUM.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { config } from "../src/config.js";
import {
  SUMMARY_MARKER,
  estimateTokens,
  packMessages,
  protectBoundary,
  truncateToolOutputs,
} from "../src/context.js";
import type { ChatMessage, ToolCall } from "../src/types.js";

// _restore_config fixture: saves and restores the knobs; aggressive defaults
// for the tests (trims everything old enough)
let saved: {
  packContext: boolean;
  toolOutputKeepTurns: number;
  toolOutputProtectTokens: number;
  toolOutputPruneMinimum: number;
  toolOutputStubThreshold: number;
  toolOutputStubHead: number;
};

beforeEach(() => {
  saved = {
    packContext: config.packContext,
    toolOutputKeepTurns: config.toolOutputKeepTurns,
    toolOutputProtectTokens: config.toolOutputProtectTokens,
    toolOutputPruneMinimum: config.toolOutputPruneMinimum,
    toolOutputStubThreshold: config.toolOutputStubThreshold,
    toolOutputStubHead: config.toolOutputStubHead,
  };
  config.packContext = true;
  config.toolOutputKeepTurns = 1;
  config.toolOutputProtectTokens = 0;
  config.toolOutputPruneMinimum = 0;
  config.toolOutputStubThreshold = 600;
  config.toolOutputStubHead = 300;
});

afterEach(() => {
  Object.assign(config, saved);
});

/** One turn = one user msg followed by assistant(tool_calls) -> tool pairs. */
function turn(idx: number, nTools: number, size = 3000): ChatMessage[] {
  const msgs: ChatMessage[] = [{ role: "user", content: `task ${idx}` }];
  for (let i = 0; i < nTools; i++) {
    const cid = `${idx}-${i}`;
    msgs.push({ role: "assistant", content: "", tool_calls: [{ id: cid } as ToolCall] });
    msgs.push({ role: "tool", tool_call_id: cid, content: `r${cid} ` + "Z".repeat(size) });
  }
  return msgs;
}

function conversation(nTurns: number, toolsPerTurn = 1, size = 3000): ChatMessage[] {
  const msgs: ChatMessage[] = [{ role: "system", content: "sys" }];
  for (let t = 0; t < nTurns; t++) msgs.push(...turn(t, toolsPerTurn, size));
  return msgs;
}

/** One turn that writes a large file via write_file. */
function writeTurn(idx: number, size: number): ChatMessage[] {
  const args = JSON.stringify({ path: `f${idx}.html`, content: "X".repeat(size) });
  const cid = `w${idx}`;
  return [
    { role: "user", content: `write ${idx}` },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: cid, type: "function", function: { name: "write_file", arguments: args } }],
    },
    { role: "tool", tool_call_id: cid, content: `File created: f${idx}.html` },
  ];
}

describe("context", () => {
  it("test_last_turn_never_pruned", () => {
    // with KEEP_TURNS=1, the last turn stays intact; earlier turns are trimmed
    const msgs = conversation(3, 1);
    const packed = packMessages(msgs);
    const tools = packed.filter((m) => m.role === "tool");
    expect((tools[tools.length - 1]!.content as string).length).toBeGreaterThan(2000);
    for (const t of tools.slice(0, -1)) {
      expect((t.content as string).length).toBeLessThan(500);
    }
  });

  it("test_protect_tokens_keeps_recent_older_outputs_full", () => {
    // protects ~4k tokens of tool output beyond the last turn.
    // each result ~750 tokens (3000 chars/4); 4000/750 ~= 5 results preserved
    config.toolOutputProtectTokens = 4000;
    const msgs = conversation(8, 1, 3000);
    const packed = packMessages(msgs);
    const tools = packed.filter((m) => m.role === "tool");
    const full = tools.filter((t) => (t.content as string).length > 2000);
    const stubbed = tools.filter((t) => (t.content as string).length < 500);
    expect(full.length).toBeGreaterThanOrEqual(5); // last turn + ~budget
    expect(stubbed.length).toBeGreaterThanOrEqual(1); // the oldest ones trimmed
  });

  it("test_prune_minimum_preserves_prefix_when_savings_small", () => {
    // if the gain is small, trim nothing (keeps the prefix cache stable)
    config.toolOutputPruneMinimum = 10_000_000; // impossible to reach
    const msgs = conversation(5, 1);
    const packed = packMessages(msgs);
    expect(packed).toBe(msgs); // returned intact
  });

  it("test_preserves_structure_and_order", () => {
    const msgs = conversation(4, 2);
    const packed = packMessages(msgs);
    expect(packed.map((m) => m.role)).toEqual(msgs.map((m) => m.role));
    expect(packed.map((m) => m.tool_call_id)).toEqual(msgs.map((m) => m.tool_call_id));
    expect(packed.length).toBe(msgs.length);
  });

  it("test_stub_notes_original_size_and_hint", () => {
    const msgs = conversation(3, 1, 5000);
    const packed = packMessages(msgs);
    const stub = packed.find((m) => m.role === "tool" && (m.content as string).length < 500)!
      .content as string;
    expect(stub).toContain("trimmed to save context");
    expect(stub).toContain("call the tool again");
  });

  it("test_small_tool_outputs_never_trimmed", () => {
    const msgs = conversation(4, 1, 100); // below the threshold
    const packed = packMessages(msgs);
    expect(packed.map((m) => m.content)).toEqual(msgs.map((m) => m.content));
  });

  it("test_never_touches_non_tool_messages", () => {
    const msgs = conversation(3, 1);
    msgs.push({ role: "user", content: "final" });
    msgs.push({ role: "assistant", content: "A".repeat(9000) }); // large assistant stays intact
    const packed = packMessages(msgs);
    expect(packed[packed.length - 1]!.content).toBe("A".repeat(9000));
    expect(packed[0]!.content).toBe("sys"); // system intact
  });

  it("test_disabled_returns_input_unchanged", () => {
    config.packContext = false;
    const msgs = conversation(5);
    const packed = packMessages(msgs);
    expect(packed).toBe(msgs);
  });

  it("test_non_string_content_is_safe", () => {
    const msgs: ChatMessage[] = [{ role: "tool", tool_call_id: "x", content: null }];
    const packed = packMessages(msgs);
    expect(packed[0]!.content).toBeNull();
  });

  it("test_stub_never_grows_payload_under_bad_config", () => {
    // bad config: head >= threshold. Trimming must not INCREASE the payload.
    config.toolOutputStubThreshold = 300;
    config.toolOutputStubHead = 500; // larger than the threshold (invalid config)
    // content between head and head+overhead: trimming would grow it, so it must not trim
    const msgs = conversation(4, 1, 520);
    const packed = packMessages(msgs);
    for (let i = 0; i < msgs.length; i++) {
      const a = String(msgs[i]!.content ?? "");
      const b = String(packed[i]!.content ?? "");
      expect(b.length).toBeLessThanOrEqual(a.length);
    }
  });

  it("test_keep_turns_override_prunes_single_turn_context", () => {
    // sub-agent scenario: only 1 turn. default keep_turns (>=1) would preserve everything;
    // keep_turns=0 lets the token budget trim the old dumps.
    config.toolOutputProtectTokens = 2000; // ~2-3 resultados protegidos
    const msgs: ChatMessage[] = [
      { role: "system", content: "s" },
      { role: "user", content: "task" },
    ];
    for (let i = 0; i < 8; i++) {
      msgs.push({ role: "assistant", content: "", tool_calls: [{ id: `t${i}` } as ToolCall] });
      msgs.push({ role: "tool", tool_call_id: `t${i}`, content: `r${i} ` + "Z".repeat(3000) });
    }

    const dflt = packMessages(msgs); // default keep_turns -> 1 turn -> nothing trimmed
    expect(dflt).toBe(msgs);

    const overridden = packMessages(msgs, 0);
    const tools = overridden.filter((m) => m.role === "tool");
    expect(tools.some((t) => (t.content as string).length < 500)).toBe(true); // old ones trimmed
    expect(tools.some((t) => (t.content as string).length > 2000)).toBe(true); // recent ones protected
  });

  it("test_estimate_tokens_is_positive", () => {
    expect(estimateTokens(conversation(2))).toBeGreaterThan(0);
  });

  it("test_protect_boundary_ignores_summary_user_message", () => {
    // the compaction summary is a user message with SUMMARY_MARKER: it must not
    // count as a real turn when computing the protection boundary
    const msgs: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "real one" },
      { role: "assistant", content: "a" },
      { role: "user", content: `${SUMMARY_MARKER}\n\nsummary body` },
      { role: "assistant", content: "ack" },
      { role: "user", content: "real two" },
    ];
    // keep_turns=2: skipping the summary, the boundary goes back to "real one" (index 1)
    expect(protectBoundary(msgs, 2)).toBe(1);
  });

  // --- pruning of ARGUMENTS of old write_file/edit_file -----------------------
  // The full content of each written file travels inside
  // assistant.tool_calls and was resent whole on every turn; old calls
  // must become a stub.

  it("test_old_write_file_arguments_are_trimmed", () => {
    const msgs: ChatMessage[] = [{ role: "system", content: "sys" }];
    for (let t = 0; t < 3; t++) msgs.push(...writeTurn(t, 5000));
    const packed = packMessages(msgs);
    const assistants = packed.filter((m) => m.role === "assistant");
    // old turns: trimmed; last turn (KEEP_TURNS=1): intact
    for (const old of assistants.slice(0, -1)) {
      const args = JSON.parse(old.tool_calls![0]!.function.arguments) as {
        path: string;
        content: string;
      };
      expect(args.path.startsWith("f")).toBe(true); // path preserved
      expect(args.content.length).toBeLessThan(1000);
      expect(args.content).toContain("already applied on disk");
    }
    const last = JSON.parse(
      assistants[assistants.length - 1]!.tool_calls![0]!.function.arguments,
    ) as { content: string };
    expect(last.content.length).toBe(5000);
  });

  it("test_trimmed_arguments_remain_valid_json_and_do_not_mutate_original", () => {
    const msgs: ChatMessage[] = [{ role: "system", content: "sys" }];
    for (let t = 0; t < 3; t++) msgs.push(...writeTurn(t, 5000));
    const original = JSON.stringify(msgs);
    const packed = packMessages(msgs);
    for (const m of packed) {
      for (const tc of m.tool_calls ?? []) {
        JSON.parse(tc.function.arguments); // never leaves invalid JSON
      }
    }
    expect(JSON.stringify(msgs)).toBe(original); // the saved history stays complete
  });

  it("test_write_arguments_protected_by_token_budget", () => {
    // with a high budget, nothing is trimmed (recent writes fit in the protection)
    config.toolOutputProtectTokens = 1_000_000;
    const msgs: ChatMessage[] = [{ role: "system", content: "sys" }];
    for (let t = 0; t < 4; t++) msgs.push(...writeTurn(t, 5000));
    const packed = packMessages(msgs);
    expect(packed).toBe(msgs);
  });

  it("test_malformed_arguments_are_left_intact", () => {
    const msgs: ChatMessage[] = [{ role: "system", content: "sys" }];
    msgs.push(...writeTurn(0, 5000));
    const broken = '{"path": "x.html", "content": "' + "X".repeat(5000); // truncated JSON
    msgs.push({ role: "user", content: "again" });
    msgs.push({
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "b1", type: "function", function: { name: "write_file", arguments: broken } },
      ],
    });
    msgs.push({ role: "tool", tool_call_id: "b1", content: "err" });
    msgs.push(...writeTurn(2, 5000));
    const packed = packMessages(msgs);
    const kept = packed.find((m) => m.tool_calls && m.tool_calls[0]!.id === "b1")!;
    expect(kept.tool_calls![0]!.function.arguments).toBe(broken); // invalid: intact
  });

  it("test_summary_truncation_also_stubs_write_arguments", () => {
    // the summary entry (compaction) must not carry whole files
    const msgs: ChatMessage[] = [{ role: "system", content: "sys" }, ...writeTurn(0, 8000)];
    const cut = truncateToolOutputs(msgs, 2000);
    const args = JSON.parse(cut[2]!.tool_calls![0]!.function.arguments) as { content: string };
    expect(args.content.length).toBeLessThan(2500);
    expect(args.content).toContain("already applied on disk");
  });
});
