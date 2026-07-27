// 1:1 mirror of tests/test_cli_ux.py: CLI UX (persistent prompt history or
// fallback) without starting the REPL. HOME is isolated so as not to touch the
// user's real ~/.reagent.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { config } from "../src/config.js";
import {
  completeLine,
  longestCommonPrefix,
  makePromptSession,
  promptHistory,
} from "../src/cli/repl.js";

let savedHome: string | undefined;
let savedUserProfile: string | undefined;
let tmpHome: string;
const originalRoot = config.root;
let project: string;

beforeEach(() => {
  // os.homedir() reads $HOME on POSIX but %USERPROFILE% on win32, so both
  // must be faked for the isolation to hold on every platform.
  savedHome = process.env.HOME;
  savedUserProfile = process.env.USERPROFILE;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "reagent-home-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  project = config.setRoot(fs.mkdtempSync(path.join(os.tmpdir(), "reagent-cli-ux-")));
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = savedUserProfile;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  config.setRoot(originalRoot);
  fs.rmSync(project, { recursive: true, force: true });
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

  it("test_completer_offers_every_real_command_not_just_the_original_subset", () => {
    // These are real, documented, working commands (slash-commands.ts
    // handleCommand) that used to be missing from the Tab-completion list.
    for (const cmd of ["/doctor", "/mode", "/plan", "/coordinator", "/spawn"]) {
      const [hits] = completeLine(cmd);
      expect(hits, `${cmd} should be offered by completeLine`).toContain(cmd);
    }
  });

  it("test_completer_lists_at_file_candidates_under_prefix", () => {
    fs.mkdirSync(path.join(project, "src", "cli"), { recursive: true });
    fs.writeFileSync(path.join(project, "src", "cli", "main.ts"), "export {}\n");
    fs.writeFileSync(path.join(project, "README.md"), "# hi\n");

    const [rootHits] = completeLine("@");
    expect(rootHits).toContain("@src/");
    expect(rootHits).toContain("@README.md");

    const [srcHits, srcSub] = completeLine("@src/");
    expect(srcSub).toBe("@src/");
    expect(srcHits).toContain("@src/cli/");

    const [fileHits] = completeLine("@src/cli/ma");
    expect(fileHits).toEqual(["@src/cli/main.ts"]);
  });

  it("test_longest_common_prefix", () => {
    expect(longestCommonPrefix(["@src/a", "@src/b"])).toBe("@src/");
    expect(longestCommonPrefix(["@src/", "@src/"])).toBe("@src/");
    expect(longestCommonPrefix([])).toBe("");
  });
});
