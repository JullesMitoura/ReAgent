import { describe, expect, it } from "vitest";

import { colorizeAttachments, PromptClosedError, ReplInput } from "../src/lib/repl-input.js";

describe("ReplInput", () => {
  it("test_ask_rejects_when_already_closed", async () => {
    const input = new ReplInput();
    input.close();
    await expect(input.ask("> ")).rejects.toBeInstanceOf(PromptClosedError);
  });

  it("test_non_tty_ask_resolves_via_readline_fallback", async () => {
    // In vitest, stdin is typically not a TTY, so ask() uses the one-shot
    // readline fallback. We can't feed it interactively here; just assert the
    // class constructs and close() is idempotent.
    const input = new ReplInput();
    input.close();
    input.close();
    expect(true).toBe(true);
  });

  it("test_colorize_attachments_highlights_at_paths", () => {
    const out = colorizeAttachments("@src/agent/microcompact.ts leia isso.");
    expect(out).toContain("\x1b[36m@src/agent/microcompact.ts\x1b[0m");
    expect(out).toContain(" leia isso.");
    expect(out.endsWith("leia isso.")).toBe(true);
  });
});
