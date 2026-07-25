import { afterEach, describe, expect, it, vi } from "vitest";
import { runTurn, toChat, TurnError } from "./api";
import type { ChatMessage } from "./types";
import type { LiveTurnHandlers } from "./api";

describe("toChat", () => {
  it("converte histórico bruto (formato OpenAI) em ChatMessage[]", () => {
    const raw = [
      { role: "user", content: "list the files" },
      {
        role: "assistant",
        content: "Sure, running it.",
        tool_calls: [
          { id: "call_1", function: { name: "bash", arguments: '{"cmd":"ls"}' } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "a.txt\nb.txt" },
    ];

    const out = toChat(raw);

    const expected: ChatMessage[] = [
      { role: "user", content: "list the files" },
      { role: "assistant", content: "Sure, running it." },
      {
        role: "tool",
        id: "call_1",
        name: "bash",
        args: '{"cmd":"ls"}',
        result: "a.txt\nb.txt",
        status: "done",
      },
    ];

    expect(out).toEqual(expected);
  });

  it("oculta o resumo de compactação (prefixo real do backend) e o ack do assistant", () => {
    const raw = [
      { role: "user", content: "hello" },
      {
        role: "user",
        content: "[Summary of the earlier conversation (history compacted)]\n\n- did stuff",
      },
      { role: "assistant", content: "Understood. I'll continue from this summary." },
      { role: "assistant", content: "Next step done." },
    ];

    expect(toChat(raw)).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "Next step done." },
    ]);
  });

  it("oculta também variações do prefixo do resumo (prefixo estável)", () => {
    const raw = [{ role: "user", content: "[Summary of the previous conversation...] blah" }];
    expect(toChat(raw)).toEqual([]);
  });

  it("usa fallback quando o tool result não tem tool_call correspondente", () => {
    const out = toChat([{ role: "tool", tool_call_id: "orphan", content: "res" }]);
    expect(out).toEqual([
      { role: "tool", id: "orphan", name: "tool", args: "", result: "res", status: "done" },
    ]);
  });
});

/** Fake fetch Response streaming the given already-formatted SSE frames (each
 *  including its own "data: ...\n\n" wrapper), then closing the stream. */
function sseResponse(frames: string[]): Response {
  let i = 0;
  const encoder = new TextEncoder();
  const reader = {
    read: async () => {
      if (i < frames.length) {
        const value = encoder.encode(frames[i]);
        i += 1;
        return { done: false, value };
      }
      return { done: true, value: undefined };
    },
    cancel: async () => {},
  };
  return { ok: true, body: { getReader: () => reader } } as unknown as Response;
}

const noopHandlers: LiveTurnHandlers = {
  onToolStart: () => {},
  onToolEnd: () => {},
  onTodos: () => {},
  askPermission: async () => "once",
  askQuestion: async () => "",
  onToken: () => {},
  onUsage: () => {},
  onStatus: () => {},
  onDone: () => {},
};

describe("runTurn (SSE round trip)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("threads the done event's truncated flag through to onDone instead of dropping it", async () => {
    const frame = `data: ${JSON.stringify({
      type: "done",
      content: "Reached the tool-iteration limit (40 rounds) for this turn.",
      truncated: true,
    })}\n\n`;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse([frame])));

    let received: [string, boolean, boolean | undefined] | null = null;
    await runTurn("sid", "hi", {
      ...noopHandlers,
      onDone: (content, streamedAny, truncated) => {
        received = [content, streamedAny, truncated];
      },
    });

    expect(received).toEqual(["Reached the tool-iteration limit (40 rounds) for this turn.", false, true]);
  });

  it("throws a TurnError carrying error_info instead of discarding it", async () => {
    const frame = `data: ${JSON.stringify({
      type: "error",
      message: "boom",
      error_info: { kind: "rate_limit", http_status: 429 },
    })}\n\n`;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse([frame])));

    let caught: unknown;
    try {
      await runTurn("sid", "hi", noopHandlers);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(TurnError);
    expect((caught as TurnError).errorInfo).toEqual({ kind: "rate_limit", http_status: 429 });
    expect((caught as TurnError).message).toBe("boom");
  });
});
