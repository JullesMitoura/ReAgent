// Regression tests for a severe bug found while investigating a user report:
// the whole `reagent` process silently died right after a permission prompt
// (visible as Node's "Warning: Detected unsettled top-level await" instead of
// returning to the `❯` prompt). Root cause, confirmed with a real PTY
// (node-pty) and a minimal repro: permissions.ts/question.ts/trust.ts each
// created their OWN `readline.createInterface({ input: process.stdin, ... })`
// per prompt. In the REPL, a PERSISTENT readline.Interface already owns
// process.stdin for the whole session; a second interface on the same
// stream, once closed, leaves the first one unable to register its next
// question() as pending I/O, so Node considers the event loop empty and
// exits — even though the REPL loop is logically still "running", just
// waiting on its next prompt.
//
// The fix (lib/interactive-line.ts): a single shared line-reader, installed
// once by the REPL's persistent interface; every interactive prompt reads
// through it instead of creating a conflicting one.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { config } from "../src/config.js";
import { askLine, setSharedLineReader } from "../src/lib/interactive-line.js";
import { confirmBash } from "../src/permissions.js";

afterEach(() => {
  setSharedLineReader(null);
});

describe("askLine", () => {
  it("test_uses_the_shared_reader_when_one_is_installed", async () => {
    const calls: string[] = [];
    setSharedLineReader(async (prompt) => {
      calls.push(prompt);
      return "from shared reader";
    });
    const answer = await askLine("pick one: ");
    expect(answer).toBe("from shared reader");
    expect(calls).toEqual(["pick one: "]);
  });
});

describe("permissions.ts reads interactive prompts through the shared reader", () => {
  const originalRoot = config.root;
  let project: string;

  afterEach(() => {
    config.setRoot(originalRoot);
    if (project) fs.rmSync(project, { recursive: true, force: true });
  });

  it("test_confirm_bash_uses_the_shared_reader_instead_of_its_own_readline_interface", async () => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), "reagent-interactive-line-"));
    config.setRoot(project);
    config.autoApprove = false;

    const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });

    const prompts: string[] = [];
    setSharedLineReader(async (prompt) => {
      prompts.push(prompt);
      return "y"; // approve once
    });

    try {
      // A command that is neither auto-safe nor dangerous, so it must reach
      // the interactive prompt (proving the real permission flow, not just
      // the isolated helper).
      const approved = await confirmBash("reagent-test-marker-cmd-xyz");
      expect(approved).toBe(true);
      // If this had fallen back to its own readline.Interface reading real
      // stdin (empty/non-interactive in the test runner), it would resolve
      // to "" -> denied, or hang; getting `true` here proves the shared
      // reader answered it.
      expect(prompts.length).toBeGreaterThan(0);
    } finally {
      if (originalIsTTY) Object.defineProperty(process.stdin, "isTTY", originalIsTTY);
    }
  });
});
