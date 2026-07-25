// Microcompaction: destructive clearing of OLD tool result content in the
// persisted history, without ever touching message structure or the
// assistant.tool_calls ↔ tool pairing.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MICROCOMPACT_KEEP_RECENT,
  MICROCOMPACT_NOTE,
  microcompactIfNeeded,
  microcompactMessages,
} from "../src/agent/microcompact.js";
import { config } from "../src/config.js";
import { estimateTokens, packMessages } from "../src/context.js";
import { Session } from "../src/session.js";
import type { ChatMessage, ToolCall } from "../src/types.js";

const originalRoot = config.root;
const originalThreshold = config.compactThreshold;
let project: string;

beforeEach(() => {
  project = config.setRoot(fs.mkdtempSync(path.join(os.tmpdir(), "reagent-micro-")));
});

afterEach(() => {
  config.compactThreshold = originalThreshold;
  config.setRoot(originalRoot);
  fs.rmSync(project, { recursive: true, force: true });
});

/** History with `n` assistant(tool_calls) → tool pairs of `size`-char results. */
function history(n: number, size = 3000): ChatMessage[] {
  const msgs: ChatMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "task" },
  ];
  for (let i = 0; i < n; i++) {
    msgs.push({ role: "assistant", content: "", tool_calls: [{ id: `t${i}` } as ToolCall] });
    msgs.push({ role: "tool", tool_call_id: `t${i}`, content: `r${i} ` + "Z".repeat(size) });
  }
  return msgs;
}

describe("microcompact", () => {
  it("clears old large tool results and keeps the last N intact", () => {
    const msgs = history(15);
    const cleared = microcompactMessages(msgs);
    expect(cleared).toBe(5); // 15 results, last 10 protected

    const tools = msgs.filter((m) => m.role === "tool");
    for (const t of tools.slice(0, 5)) {
      expect(t.content).toBe(MICROCOMPACT_NOTE);
    }
    for (const t of tools.slice(-MICROCOMPACT_KEEP_RECENT)) {
      expect(t.content).not.toBe(MICROCOMPACT_NOTE);
      expect((t.content as string).length).toBeGreaterThan(2000);
    }
  });

  it("preserves message count, order and tool_call pairing", () => {
    const msgs = history(15);
    const rolesBefore = msgs.map((m) => m.role);
    const idsBefore = msgs.map((m) => m.tool_call_id);
    const callsBefore = msgs.map((m) => JSON.stringify(m.tool_calls ?? null));

    microcompactMessages(msgs);

    expect(msgs.map((m) => m.role)).toEqual(rolesBefore);
    expect(msgs.map((m) => m.tool_call_id)).toEqual(idsBefore);
    expect(msgs.map((m) => JSON.stringify(m.tool_calls ?? null))).toEqual(callsBefore);
    // every assistant call id still has its tool answer
    for (const m of msgs) {
      for (const tc of m.tool_calls ?? []) {
        expect(msgs.some((t) => t.role === "tool" && t.tool_call_id === tc.id)).toBe(true);
      }
    }
  });

  it("is idempotent", () => {
    const msgs = history(15);
    expect(microcompactMessages(msgs)).toBe(5);
    const snapshot = JSON.stringify(msgs);
    expect(microcompactMessages(msgs)).toBe(0);
    expect(JSON.stringify(msgs)).toBe(snapshot);
  });

  it("never clears small tool results nor user/assistant messages", () => {
    const msgs = history(15, 200); // below the 1000-char floor
    msgs.push({ role: "assistant", content: "A".repeat(9000) });
    const snapshot = JSON.stringify(msgs);
    expect(microcompactMessages(msgs)).toBe(0);
    expect(JSON.stringify(msgs)).toBe(snapshot);
  });

  it("microcompactIfNeeded is a no-op below the soft threshold", () => {
    config.compactThreshold = 10_000_000;
    const session = new Session({ id: "micro-noop", messages: history(15) });
    const snapshot = JSON.stringify(session.messages);
    expect(microcompactIfNeeded(session)).toBe(false);
    expect(JSON.stringify(session.messages)).toBe(snapshot);
  });

  it("microcompactIfNeeded clears above the soft threshold and refreshes usage", () => {
    const session = new Session({ id: "micro-run", messages: history(15) });
    // history is ~12k tokens; a threshold of 1000 puts it far past 60%
    config.compactThreshold = 1000;
    session.usage.last_prompt_tokens = 999_999;

    expect(microcompactIfNeeded(session)).toBe(true);

    const tools = session.messages.filter((m) => m.role === "tool");
    expect(tools.some((t) => t.content === MICROCOMPACT_NOTE)).toBe(true);
    expect(session.usage.last_prompt_tokens).toBe(
      estimateTokens(packMessages(session.messages)),
    );
  });
});
