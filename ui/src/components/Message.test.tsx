import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Message } from "./Message";
import type { ChatMessage } from "../types";

describe("Message", () => {
  it("renders user message text", () => {
    const msg: ChatMessage = { role: "user", content: "Ola mundo" };
    const { getByText } = render(<Message msg={msg} />);
    expect(getByText("Ola mundo")).toBeTruthy();
  });

  it("shows a friendly action label while running and keeps the raw tool name", () => {
    const msg: ChatMessage = {
      role: "tool",
      id: "t1",
      name: "read_file",
      args: JSON.stringify({ path: "src/index.ts" }),
      status: "running",
    };
    const { getByText } = render(<Message msg={msg} />);
    expect(getByText("Reading")).toBeTruthy(); // rotulo amigavel animado
    expect(getByText(/read_file/)).toBeTruthy(); // nome cru ainda disponivel no detalhe
  });

  it("shows the past-tense action and target when done", () => {
    const msg: ChatMessage = {
      role: "tool",
      id: "t2",
      name: "write_file",
      args: JSON.stringify({ path: "puzzle.html" }),
      status: "done",
      result: "File created",
    };
    const { getByText } = render(<Message msg={msg} />);
    expect(getByText("Wrote")).toBeTruthy();
    expect(getByText("puzzle.html")).toBeTruthy();
  });

  it("is wrapped in React.memo (referentially stable memo component)", () => {
    // React.memo retorna um objeto exótico com $$typeof === Symbol.for("react.memo").
    expect((Message as { $$typeof?: symbol }).$$typeof).toBe(Symbol.for("react.memo"));
  });

  it("does not recreate DOM when re-rendered with the same msg object", () => {
    const msg: ChatMessage = { role: "user", content: "estavel" };
    const { getByText, rerender } = render(<Message msg={msg} />);
    const firstNode = getByText("estavel");
    rerender(<Message msg={msg} />);
    // Mesma referencia de msg: memo evita re-render, o no do DOM e o mesmo.
    expect(getByText("estavel")).toBe(firstNode);
  });
});
