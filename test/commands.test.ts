// 1:1 mirror of tests/test_commands.py: custom .md commands.
// `project` fixture (tmp root with autoApprove/contextFile) and isolated HOME
// (POSIX os.homedir() reads $HOME, the equivalent of the monkeypatch on Path.home).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { config } from "../src/config.js";
import { expandArguments, loadCommands } from "../src/custom-commands.js";

const originalRoot = config.root;
const cleanups: string[] = [];
let savedHome: string | undefined;
let project: string;

function mktemp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

function writeCmd(base: string, name: string, text: string): void {
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, `${name}.md`), text, "utf8");
}

beforeEach(() => {
  project = mktemp("reagent-project-");
  config.setRoot(project);
  config.autoApprove = true;
  config.contextFile = false;
  // Fake HOME: the global side of loadCommands never sees the real ~/.reagent
  savedHome = process.env.HOME;
  const fakeHome = path.join(project, "fake-home");
  fs.mkdirSync(fakeHome, { recursive: true });
  process.env.HOME = fakeHome;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  config.setRoot(originalRoot);
  while (cleanups.length) {
    fs.rmSync(cleanups.pop() as string, { recursive: true, force: true });
  }
});

describe("commands", () => {
  it("test_load_project_command_with_frontmatter", () => {
    writeCmd(
      path.join(config.stateDir, "commands"),
      "test",
      "---\ndescription: run the test suite\n---\nRun the tests and fix failures.",
    );
    const loaded = loadCommands();
    expect(loaded["test"]?.description).toBe("run the test suite");
    expect(loaded["test"]?.body).toBe("Run the tests and fix failures.");
  });

  it("test_load_without_frontmatter", () => {
    writeCmd(path.join(config.stateDir, "commands"), "plain", "Just do the thing.");
    expect(loadCommands()["plain"]).toEqual({ body: "Just do the thing.", description: "" });
  });

  it("test_project_overrides_global", () => {
    const fakeHome = process.env.HOME as string;
    writeCmd(path.join(fakeHome, ".reagent", "commands"), "deploy", "global body");
    writeCmd(path.join(config.stateDir, "commands"), "deploy", "project body");
    expect(loadCommands()["deploy"]?.body).toBe("project body");
  });

  it("test_invalid_names_and_empty_bodies_are_skipped", () => {
    const base = path.join(config.stateDir, "commands");
    writeCmd(base, "ok", "body");
    fs.writeFileSync(path.join(base, "we ird.md"), "x");
    fs.writeFileSync(path.join(base, "empty.md"), "---\ndescription: only meta\n---\n");
    const loaded = loadCommands();
    expect("ok" in loaded).toBe(true);
    expect("we ird" in loaded).toBe(false);
    expect("empty" in loaded).toBe(false);
  });

  it("test_expand_arguments", () => {
    const body = "Review $1 focusing on $2. Full input: $ARGUMENTS";
    const out = expandArguments(body, "src/app.py security");
    expect(out).toBe("Review src/app.py focusing on security. Full input: src/app.py security");
  });

  it("test_expand_missing_positionals_become_empty", () => {
    // missing positionals become empty (the separator spaces remain)
    expect(expandArguments("do $1 $2 $9 end", "only")).toBe("do only   end");
  });
});
