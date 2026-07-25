// 1:1 mirror of the system prompt tests in tests/test_agent_render.py
// (test_system_prompt_has_delete_and_efficiency_guidance,
// test_system_prompt_hardening_sections,
// test_system_prompt_approval_text_follows_config,
// test_system_prompt_network_text_follows_config,
// test_system_prompt_omits_sandbox_lines_when_unavailable) and of
// tests/test_project_context.py (test_system_prompt_guards_entry_point_overwrite).
//
// Ports buildSystemPrompt (src/system-prompt.ts). Sandbox availability
// (sandbox.available) is mocked via vi.mock, as in the other tests that depend
// on it; the Python fixtures `project` and `_isolated_user_profile` become a
// beforeEach with fs.mkdtempSync (tmp root + autoApprove + contextFile off,
// USER.md in tmp).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { config } from "../src/config.js";
import { projectInstructionBlocks } from "../src/prompts/compose.js";
import { available } from "../src/sandbox.js";
import { buildSystemPrompt } from "../src/system-prompt.js";

// vi.mock hoisted: replaces the module for ALL importers, including
// system-prompt.ts, which imports `available` from the same resolved path.
vi.mock("../src/sandbox.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/sandbox.js")>();
  return { ...actual, available: vi.fn(actual.available) };
});

const realSandbox = await vi.importActual<typeof import("../src/sandbox.js")>("../src/sandbox.js");

const originalRoot = config.root;
const originalProfileFile = config.userProfileFile;
const cleanups: string[] = [];

function mktemp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

beforeEach(() => {
  // _isolated_user_profile: the tests' USER.md goes to a tmp (never the real one)
  config.userProfileFile = path.join(mktemp("reagent-profile-"), "USER.md");
  // project: temporary root with auto-approval and CONTEXT.md off
  config.setRoot(mktemp("reagent-sysprompt-"));
  config.autoApprove = true;
  config.contextFile = false;
  // by default the sandbox uses the real implementation; specific tests override it
  vi.mocked(available).mockImplementation(realSandbox.available);
});

afterEach(() => {
  config.userProfileFile = originalProfileFile;
  config.setRoot(originalRoot); // recomputes autoApprove/sandboxNetwork from env/config
  while (cleanups.length) {
    fs.rmSync(cleanups.pop() as string, { recursive: true, force: true });
  }
});

describe("system-prompt", () => {
  it("test_system_prompt_has_delete_and_efficiency_guidance", () => {
    const p = buildSystemPrompt();
    expect(p).toContain("delete_file");
    expect(p).toContain("empty file"); // rule about not deleting by writing empty
    expect(p).toContain("read a file once"); // efficiency rule
  });

  it("test_system_prompt_communication_prefers_signal_over_volume", () => {
    const p = buildSystemPrompt();
    expect(p).toContain("prefer signal over volume");
    expect(p).toContain("Do not restate the user's request");
    expect(p).toContain("final message is the report");
    expect(p).not.toContain("Be direct and concise"); // replaced by concrete anti-waste rules
  });

  it("test_system_prompt_hardening_sections", () => {
    const p = buildSystemPrompt();
    expect(p).toContain("Git safety");
    expect(p).toContain("git reset --hard");
    expect(p).toContain("Before declaring done");
    expect(p).toContain("Today's date");
    expect(p).toContain(os.type()); // Node equivalent of platform.system()
    expect(p).toContain("Shell: bash");
  });

  it.each([true, false])("test_system_prompt_approval_text_follows_config[%s]", (auto) => {
    config.autoApprove = auto;
    const p = buildSystemPrompt();
    if (auto) {
      expect(p).toContain("without approval prompts");
      expect(p).not.toContain("may be denied");
    } else {
      expect(p).toContain("may be denied");
      expect(p).not.toContain("without approval prompts");
    }
  });

  it.each([true, false])("test_system_prompt_network_text_follows_config[%s]", (network) => {
    vi.mocked(available).mockReturnValue(true);
    config.sandboxNetwork = network;
    const p = buildSystemPrompt();
    expect(p.includes("Network access is blocked")).toBe(!network);
  });

  it("test_system_prompt_omits_sandbox_lines_when_unavailable", () => {
    vi.mocked(available).mockReturnValue(false);
    const p = buildSystemPrompt();
    expect(p).not.toContain("OS sandbox");
    expect(p).toContain("Sandbox and approvals:"); // the approvals section remains
  });

  it("test_system_prompt_guards_entry_point_overwrite", () => {
    config.contextFile = false;
    const p = buildSystemPrompt();
    expect(p).toContain("NEVER replace the entire contents of an existing entry-point");
    expect(p).toContain("self-contained .html");
    expect(p).toContain("Do NOT read the whole repository");
  });

  it("test_system_prompt_coordinator_phases", () => {
    config.coordinatorMode = true;
    const p = buildSystemPrompt();
    expect(p).toContain("Coordinator mode");
    expect(p).toContain("Research");
    expect(p).toContain("Verification");
    expect(p).toContain("Never fabricate");
    config.coordinatorMode = false;
  });

  it("test_system_prompt_question_decision_guidance", () => {
    const p = buildSystemPrompt();
    expect(p).toContain("sensible defaults");
    expect(p).toContain("exit_plan_mode");
    expect(p).toContain("When you have enough information to act, act");
  });

  it("test_system_prompt_spawn_and_restraint", () => {
    const p = buildSystemPrompt();
    expect(p).toContain("Spawn policy");
    expect(p).toContain("Delegate only when the payoff");
  });

  it("test_system_prompt_coordinator_continue_vs_spawn", () => {
    config.coordinatorMode = true;
    const p = buildSystemPrompt();
    expect(p).toContain("Continue vs spawn");
    expect(p).toContain("send_message");
    config.coordinatorMode = false;
  });

  it("test_system_prompt_ported_claude_code_rules", () => {
    const p = buildSystemPrompt();
    // no unnecessary additions / error handling / compat hacks
    expect(p).toContain("Three similar lines is better than a premature abstraction");
    expect(p).toContain("system boundaries");
    // comments why-only, docs restraint, code references, security
    expect(p).toContain("WHY is non-obvious");
    expect(p).toContain("NEVER proactively create documentation files");
    expect(p).toContain("file_path:line_number");
    expect(p).toContain("OWASP");
    // full scope + truthful reporting + corrections restraint
    expect(p).toContain("The requested scope is the deliverable");
    expect(p).toContain("Report outcomes faithfully");
    expect(p).toContain("Corrections:");
    // research before asking a clarifying question
    expect(p).toContain("before asking, spend a short read-only investigation");
  });

  it("test_system_prompt_git_stash_safety", () => {
    const p = buildSystemPrompt();
    expect(p).toContain("stash stack is shared");
    expect(p).toContain("WIP commit");
    expect(p).toContain("git stash apply");
  });

  it("test_system_prompt_subagent_briefing_zero_context", () => {
    const p = buildSystemPrompt();
    expect(p).toContain("ZERO context");
    expect(p).toContain("Never delegate understanding");
    expect(p).toContain("in ONE message");
  });
});

describe("project instructions hierarchy", () => {
  it("reads AGENTS.md/CLAUDE.md from ancestors, outermost first, root last, deduped per dir", () => {
    const base = mktemp("reagent-hier-");
    const mid = path.join(base, "mid");
    const inner = path.join(mid, "inner");
    fs.mkdirSync(inner, { recursive: true });
    fs.writeFileSync(path.join(base, "AGENTS.md"), "outermost instructions");
    fs.writeFileSync(path.join(mid, "CLAUDE.md"), "mid instructions");
    fs.writeFileSync(path.join(inner, "AGENTS.md"), "root agents instructions");
    fs.writeFileSync(path.join(inner, "CLAUDE.md"), "root claude instructions");
    config.setRoot(inner);
    config.autoApprove = true;
    config.contextFile = false;

    const p = buildSystemPrompt();
    const root = config.root; // realpathed by setRoot
    const midReal = path.dirname(root);
    const baseReal = path.dirname(midReal);
    expect(p).toContain(`Project instructions (${path.join(baseReal, "AGENTS.md")}):`);
    expect(p).toContain(`Project instructions (${path.join(midReal, "CLAUDE.md")}):`);
    expect(p).toContain(`Project instructions (${path.join(root, "AGENTS.md")}):`);
    // dedup within a dir: AGENTS.md wins over CLAUDE.md
    expect(p).not.toContain("root claude instructions");
    // order: outermost first, root last (highest precedence)
    expect(p.indexOf("outermost instructions")).toBeGreaterThan(-1);
    expect(p.indexOf("outermost instructions")).toBeLessThan(p.indexOf("mid instructions"));
    expect(p.indexOf("mid instructions")).toBeLessThan(p.indexOf("root agents instructions"));
  });

  it("caps total instruction chars and appends a truncation note", () => {
    const root = mktemp("reagent-trunc-");
    fs.writeFileSync(path.join(root, "AGENTS.md"), "x".repeat(50_000));
    config.setRoot(root);
    config.autoApprove = true;
    config.contextFile = false;

    const p = buildSystemPrompt();
    expect(p).toContain("[Project instructions truncated");
    expect(p).toContain("x".repeat(40_000));
    expect(p).not.toContain("x".repeat(40_001));
  });

  it("projectInstructionBlocks: global ~/.reagent first, stops at home, caps at 5 ancestor levels", () => {
    const home = mktemp("reagent-home-");
    fs.mkdirSync(path.join(home, ".reagent"), { recursive: true });
    fs.writeFileSync(path.join(home, ".reagent", "AGENTS.md"), "global");
    fs.writeFileSync(path.join(home, ".reagent", "CLAUDE.md"), "global claude");
    fs.writeFileSync(path.join(home, "CLAUDE.md"), "home claude");
    const deep = path.join(home, "a", "b", "c", "d", "e", "f", "g");
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, "AGENTS.md"), "root file");

    // 7 levels below home: the upward walk is capped at 5 ancestors, so
    // home/CLAUDE.md is out of reach; global (deduped to AGENTS.md) + root remain.
    const blocksDeep = projectInstructionBlocks(deep, home);
    expect(blocksDeep.map((b) => b.text)).toEqual(["global", "root file"]);

    // shallow root: home itself is within reach and included between them
    const shallow = path.join(home, "a", "b");
    const blocksShallow = projectInstructionBlocks(shallow, home);
    expect(blocksShallow.map((b) => b.text)).toEqual(["global", "home claude"]);
  });
});
