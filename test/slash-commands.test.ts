// Tests for the pure slash-command dispatcher (cli/slash-commands.ts). There is
// no equivalent test in Python (_handle_command was exercised only by the live
// REPL); here the dispatcher is tested in isolation with a fake ReplUI, without
// touching the LLM. Fixture `project` (tmp root + autoApprove + contextFile off) and
// isolated HOME, like Python's conftest.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Agent } from "../src/agent.js";
import { ChangeTracker } from "../src/changes.js";
import { config } from "../src/config.js";
import { handleCommand } from "../src/cli/slash-commands.js";
import type { ReplUI } from "../src/cli/slash-commands.js";

const originalRoot = config.root;
const cleanups: string[] = [];
let savedHome: string | undefined;
let project: string;
let projectRoot: string; // root after setRoot (realpath resolved)

function mktemp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

function writeCmd(base: string, name: string, text: string): void {
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, `${name}.md`), text, "utf8");
}

interface Harness {
  ui: ReplUI;
  out: string[];
  turns: string[];
}

function makeUI(): Harness {
  const out: string[] = [];
  const turns: string[] = [];
  const ui: ReplUI = {
    print: (t: string) => out.push(t),
    changes: new ChangeTracker(),
    runTurn: async (_a: Agent, prompt: string) => {
      turns.push(prompt);
    },
  };
  return { ui, out, turns };
}

function joined(out: string[]): string {
  return out.join("\n");
}

beforeEach(() => {
  project = mktemp("reagent-slash-");
  projectRoot = config.setRoot(project);
  config.autoApprove = true;
  config.contextFile = false;
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

describe("slash-commands", () => {
  it("test_exit_and_quit_return_null", async () => {
    const { ui } = makeUI();
    const agent = new Agent();
    expect(await handleCommand("/exit", agent, ui)).toBeNull();
    expect(await handleCommand("/quit", agent, ui)).toBeNull();
  });

  it("test_help_lists_builtins_and_custom", async () => {
    writeCmd(path.join(config.stateDir, "commands"), "deploy", "---\ndescription: ship it\n---\nbody");
    const { ui, out } = makeUI();
    const agent = new Agent();
    const result = await handleCommand("/help", agent, ui);
    expect(result).toBe(agent);
    const text = joined(out);
    expect(text).toContain("/help");
    expect(text).toContain("Attachment shortcuts");
    expect(text).toContain("/deploy");
    expect(text).toContain("ship it");
  });

  it("test_new_resets_and_reports", async () => {
    const { ui, out } = makeUI();
    const agent = new Agent();
    const before = agent.session.id;
    const result = await handleCommand("/new", agent, ui);
    expect(result).toBe(agent); // same instance (reset in place)
    expect(agent.session.id).not.toBe(before);
    expect(joined(out)).toContain("New conversation started.");
  });

  it("test_unknown_command_reports_help_hint", async () => {
    const { ui, out } = makeUI();
    const agent = new Agent();
    await handleCommand("/nope", agent, ui);
    expect(joined(out)).toContain("Unknown command: /nope");
    expect(joined(out)).toContain("(try /help)");
  });

  it("test_custom_command_runs_expanded_prompt", async () => {
    writeCmd(path.join(config.stateDir, "commands"), "review", "Review $1 now");
    const { ui, turns } = makeUI();
    const agent = new Agent();
    await handleCommand("/review foo", agent, ui);
    expect(turns).toEqual(["Review foo now"]);
  });

  it("test_builtin_wins_over_custom", async () => {
    // a custom command named "tools" must NOT override the built-in /tools
    writeCmd(path.join(config.stateDir, "commands"), "tools", "custom body");
    const { ui, out, turns } = makeUI();
    const agent = new Agent();
    await handleCommand("/tools", agent, ui);
    expect(turns).toEqual([]); // built-in runs, custom is never called
    expect(joined(out)).toContain("read_file");
  });

  it("test_tools_shows_disabled_hints", async () => {
    // Deterministic: exercise the disabled-hint rendering regardless of the
    // build defaults (explore/webfetch may be enabled by default).
    config.enableWebfetch = false;
    config.enableSubagent = false;
    const { ui, out } = makeUI();
    const agent = new Agent();
    await handleCommand("/tools", agent, ui);
    const text = joined(out);
    expect(text).toContain("webfetch disabled");
    expect(text).toContain("explore disabled");
  });

  it("test_usage_prints_single_metrics_line", async () => {
    const { ui, out } = makeUI();
    const agent = new Agent();
    agent.session.usage = {
      prompt_tokens: 1234,
      completion_tokens: 56,
      last_prompt_tokens: 789,
    };
    await handleCommand("/usage", agent, ui);
    const text = joined(out);
    expect(text).toContain("prompt:");
    expect(text).toContain("output:");
    expect(text).toContain("current context:");
    expect(text).toContain("window, compacts at");
  });

  it("test_undo_reports_nothing_recorded", async () => {
    const { ui, out } = makeUI();
    const agent = new Agent();
    await handleCommand("/undo", agent, ui);
    expect(joined(out)).toContain("Nothing to undo (no file changes recorded in the last turn).");
  });

  it("test_cd_invalid_path_reports_error", async () => {
    const { ui, out } = makeUI();
    const agent = new Agent();
    const result = await handleCommand("/cd /no/such/dir/here", agent, ui);
    expect(result).toBe(agent); // root did not change
    expect(config.root).toBe(projectRoot);
    expect(joined(out)).toContain("directory not found");
  });

  it("test_cd_without_arg_shows_current_dir", async () => {
    const { ui, out } = makeUI();
    const agent = new Agent();
    await handleCommand("/cd", agent, ui);
    const text = joined(out);
    expect(text).toContain("Current directory:");
    expect(text).toContain("usage: /cd <path>");
  });

  it("test_sessions_and_search_empty", async () => {
    const { ui, out } = makeUI();
    const agent = new Agent();
    await handleCommand("/search nothinghere", agent, ui);
    expect(joined(out)).toContain("No sessions match that search.");
  });

  it("test_fork_switches_to_a_new_session", async () => {
    const { ui, out } = makeUI();
    const agent = new Agent();
    agent.session.title = "original";
    const result = await handleCommand("/fork", agent, ui);
    expect(result).not.toBe(agent);
    expect(result).not.toBeNull();
    expect((result as Agent).session.id).not.toBe(agent.session.id);
    expect((result as Agent).session.title).toContain("(fork)");
    expect(joined(out)).toContain("Session forked");
  });
});
