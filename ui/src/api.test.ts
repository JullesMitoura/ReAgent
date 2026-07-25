import { describe, expect, it } from "vitest";
import { toChat } from "./api";
import type { ChatMessage } from "./types";

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
