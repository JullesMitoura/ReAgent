// 1:1 mirror of tests/test_cli_ux.py: CLI UX (persistent prompt history or
// fallback) without starting the REPL. HOME is isolated so as not to touch the
// user's real ~/.reagent.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makePromptSession, promptHistory } from "../src/cli/repl.js";

let savedHome: string | undefined;
let tmpHome: string;

beforeEach(() => {
  savedHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "reagent-home-"));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("cli-ux", () => {
  it("test_make_prompt_session_history_is_persistent_or_fallback", () => {
    const ps = makePromptSession();
    // FileHistory when home is writable; InMemoryHistory in the fallback.
    expect(typeof ps.history.persistent).toBe("boolean");
    expect(Array.isArray(ps.history.load())).toBe(true);
    ps.close();
  });

  it("test_prompt_history_helper_returns_history", () => {
    const hist = promptHistory();
    expect(hist).toBeDefined();
    expect(typeof hist.persistent).toBe("boolean");
    expect(Array.isArray(hist.load())).toBe(true);
  });
});
