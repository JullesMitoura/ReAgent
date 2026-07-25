// 1:1 mirror of tests/test_project_context.py: auto-generated CONTEXT.md.
//
// No network: the LLM call is injectable (GenerateFn passed to generate/ensure)
// and the tests pass a non-streaming fake that returns the CONTEXT.md body.
// The `project` fixture turns contextFile off; `ctx_project` turns it back on and creates
// README.md + package.json at the root.
//
// test_ensure_only_on_first_turn_of_conversation, test_build_system_prompt_
// injects_context, test_run_events_ensures_context_once_per_session and
// test_system_prompt_guards_entry_point_overwrite depend on agent.ts and
// system-prompt.ts (phase 6): they remain as todo until those modules exist;
// the names are already in the parity map.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Agent } from "../src/agent.js";
import { config } from "../src/config.js";
import * as projectContext from "../src/project-context.js";
import {
  _gatherSignals,
  _readMeta,
  _safeFile,
  _setGeneratorVersion,
  GENERATOR_VERSION,
  ensure,
  generate,
  isStale,
  load,
  markStale,
  noteChange,
} from "../src/project-context.js";
import type { GenerateFn } from "../src/project-context.js";
import { Session } from "../src/session.js";

const originalRoot = config.root;
const cleanups: string[] = [];

function mktemp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

/** Equivalent of the Python test's _resp helper: non-streaming fake. */
function resp(content: string): GenerateFn {
  return async () => ({ choices: [{ message: { content } }] });
}

beforeEach(() => {
  // ctx_project fixture: project + contextFile on + README/package.json
  const project = mktemp("reagent-ctx-");
  config.setRoot(project);
  config.autoApprove = true;
  config.contextFile = true;
  fs.writeFileSync(path.join(config.root, "README.md"), "# Demo\nA demo project.\n");
  fs.writeFileSync(
    path.join(config.root, "package.json"),
    '{"scripts": {"build": "vite build"}}\n',
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  _setGeneratorVersion(GENERATOR_VERSION);
  config.setRoot(originalRoot);
  while (cleanups.length) {
    fs.rmSync(cleanups.pop() as string, { recursive: true, force: true });
  }
});

describe("project-context", () => {
  it("test_generate_writes_context_with_provenance_header", async () => {
    const body = await generate(
      null,
      resp("## Project\n- A demo\n## Do not touch\n- src/App.tsx\n"),
    );
    expect(body).toBeTruthy();
    expect(body).toContain("Do not touch");
    const p = path.join(config.stateDir, "CONTEXT.md");
    expect(fs.existsSync(p)).toBe(true);
    const first = fs.readFileSync(p, "utf8").split("\n")[0] as string;
    expect(first.startsWith("<!-- reagent:context ")).toBe(true);
    expect(first.endsWith("-->")).toBe(true);
    // load() returns the body WITHOUT the provenance header
    const loaded = load();
    expect(loaded.startsWith("## Project")).toBe(true);
    expect(loaded).not.toContain("reagent:context");
  });

  it("test_staleness_lifecycle", async () => {
    // cooldown zeroed: structural change/flag takes effect immediately (old semantics)
    config.contextCooldownHours = 0.0;
    const fake = resp("## Project\n- x");
    expect(isStale()).toBe(true); // does not exist yet
    await generate(null, fake);
    expect(isStale()).toBe(false); // freshly generated
    markStale();
    expect(isStale()).toBe(true); // marked
    await generate(null, fake); // regenerating clears the stale
    expect(isStale()).toBe(false);
    // changing a tracked manifest changes the signature -> stale
    fs.writeFileSync(path.join(config.root, "package.json"), '{"scripts": {"build": "tsc"}}\n');
    expect(isStale()).toBe(true);
  });

  it("test_structural_change_respects_cooldown", async () => {
    // File created/deleted does not regenerate on every conversation: waits for the cooldown.
    // A manifest change still regenerates immediately (the map is now wrong).
    config.contextCooldownHours = 24.0;
    const fake = resp("## Project\n- x");
    await generate(null, fake);
    expect(isStale()).toBe(false);
    // stale flag (agent created a file) within the cooldown: does NOT regenerate
    markStale();
    expect(isStale()).toBe(false);
    // new file at the top (changes __top__) within the cooldown: does NOT regenerate
    fs.writeFileSync(path.join(config.root, "new-file.html"), "<html></html>");
    expect(isStale()).toBe(false);
    // cooldown expired: regenerates
    config.contextCooldownHours = 0.0;
    expect(isStale()).toBe(true);
    // manifest changed: regenerates IMMEDIATELY even with a high cooldown
    config.contextCooldownHours = 24.0;
    await generate(null, fake);
    fs.writeFileSync(path.join(config.root, "package.json"), '{"scripts": {"build": "rollup"}}\n');
    expect(isStale()).toBe(true);
  });

  it("test_generator_version_bump_invalidates", async () => {
    await generate(null, resp("## Project\n- x"));
    expect(isStale()).toBe(false);
    _setGeneratorVersion(GENERATOR_VERSION + 1);
    expect(isStale()).toBe(true); // different format/version
  });

  it("test_note_change_marks_stale_only_when_structural_or_tracked", async () => {
    config.contextCooldownHours = 0.0;
    const fake = resp("## Project\n- x");
    await generate(null, fake);
    expect(isStale()).toBe(false);
    // editing an ordinary .py does NOT mark (does not change the map)
    noteChange(path.join(config.root, "foo.py"), false);
    expect(isStale()).toBe(false);
    // editing a tracked manifest marks
    noteChange(path.join(config.root, "package.json"), false);
    expect(isStale()).toBe(true);
    // regenerate and create a file (structural) marks
    await generate(null, fake);
    expect(isStale()).toBe(false);
    noteChange(path.join(config.root, "new_file.py"), true);
    expect(isStale()).toBe(true);
  });

  // the server creates a new Agent per message: the context check must
  // happen only on the first turn of the conversation, never in the middle of it
  it("test_ensure_only_on_first_turn_of_conversation", async () => {
    const ensured = vi.spyOn(projectContext, "ensure").mockResolvedValue(undefined);
    const finalResult = { content: "ok", toolCalls: [], usage: null, finishReason: "stop" };
    const a = new Agent();
    vi.spyOn(a, "streamCompletion").mockResolvedValue(finalResult);
    await a.runEvents("first", () => {});
    expect(ensured).toHaveBeenCalledTimes(1); // first turn: checked/generated
    // turn 2 in the SAME session, new instance (as the server does): does not re-check
    const b = new Agent(a.session);
    vi.spyOn(b, "streamCompletion").mockResolvedValue(finalResult);
    await b.runEvents("second", () => {});
    expect(ensured).toHaveBeenCalledTimes(1);
  });

  it("test_ensure_generates_then_skips_when_fresh", async () => {
    let calls = 0;
    const fake: GenerateFn = async () => {
      calls += 1;
      return { choices: [{ message: { content: "## Project\n- x" } }] };
    };
    await ensure(null, fake);
    expect(calls).toBe(1); // generated
    await ensure(null, fake);
    expect(calls).toBe(1); // fresh: does not regenerate
  });

  it("test_build_system_prompt_injects_context", async () => {
    const { buildSystemPrompt } = await import("../src/system-prompt.js");
    await generate(null, resp("## Project\n- MARKER_XYZ"));
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("MARKER_XYZ");
    expect(prompt).toContain("CONTEXT.md");
  });

  it("test_disabled_returns_empty_and_skips", async () => {
    config.contextFile = false;
    let called = 0;
    const fake: GenerateFn = async () => {
      called += 1;
      return { choices: [] };
    };
    expect(await generate(null, fake)).toBeNull();
    expect(load()).toBe("");
    await ensure(null, fake);
    expect(called).toBe(0); // disabled: never calls the LLM
  });

  it("test_empty_project_skips_generation", async () => {
    // empty root: no tree, no manifest -> does not generate
    const empty = mktemp("reagent-empty-");
    config.setRoot(empty);
    config.autoApprove = true;
    config.contextFile = true;
    let called = 0;
    const fake: GenerateFn = async () => {
      called += 1;
      throw new Error("should not call");
    };
    expect(await generate(null, fake)).toBeNull();
    expect(called).toBe(0);
  });

  it("test_ignores_secrets_and_state", () => {
    // .env and .reagent never enter the sampled signals
    fs.writeFileSync(path.join(config.root, ".env"), "SECRET=topsecret\n");
    const signals = _gatherSignals();
    expect(signals).not.toContain("topsecret");
    expect(signals).not.toContain(".reagent");
  });

  it("test_malformed_scalar_header_is_stale_not_crash", async () => {
    // provenance header corrupted to a valid SCALAR JSON must not
    // break isStale (regression: reading a field on a scalar); treated as regenerable
    await generate(null, resp("## Project\n- x"));
    const p = path.join(config.stateDir, "CONTEXT.md");
    const lines = fs.readFileSync(p, "utf8").split("\n");
    lines[0] = "<!-- reagent:context 5 -->"; // scalar, not object
    fs.writeFileSync(p, lines.join("\n"));
    expect(_readMeta()).toBeNull();
    expect(isStale()).toBe(true); // does not throw
  });

  it("test_symlink_not_followed_in_signals", () => {
    // a symlink pointing outside the project must NOT have its content sampled
    const outsideDir = mktemp("reagent-outside-");
    const secret = path.join(outsideDir, "outside_secret_zzz.txt");
    fs.writeFileSync(secret, "OUTSIDE_SECRET_XYZ");
    fs.unlinkSync(path.join(config.root, "README.md")); // remove the real one from the fixture
    fs.symlinkSync(secret, path.join(config.root, "README.md")); // now it is a symlink pointing outside
    const signals = _gatherSignals();
    expect(signals).not.toContain("OUTSIDE_SECRET_XYZ");
    expect(_safeFile(path.join(config.root, "README.md"))).toBe(false);
  });

  it("test_run_events_ensures_context_once_per_session", async () => {
    const ensured = vi.spyOn(projectContext, "ensure").mockResolvedValue(undefined);
    const s = Session.new();
    s.messages = [{ role: "system", content: "sys" }];
    const agent = new Agent(s);
    // avoids the real LLM loop: returns final text without tool calls
    vi.spyOn(agent, "streamCompletion").mockResolvedValue({
      content: "done",
      toolCalls: [],
      usage: null,
      finishReason: "stop",
    });
    await agent.runEvents("hi", () => {});
    expect(ensured).toHaveBeenCalledTimes(1); // generated/checked on the 1st turn
    await agent.runEvents("again", () => {});
    expect(ensured).toHaveBeenCalledTimes(1); // does not repeat in the same session
  });

  it("test_system_prompt_guards_entry_point_overwrite", async () => {
    const { buildSystemPrompt } = await import("../src/system-prompt.js");
    config.contextFile = false;
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("NEVER replace the entire contents of an existing entry-point");
    expect(prompt).toContain("self-contained .html");
    expect(prompt).toContain("Do NOT read the whole repository");
  });
});
