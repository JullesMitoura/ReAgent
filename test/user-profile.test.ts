// 1:1 mirror of tests/test_user_profile.py: user profile and the remember
// tool. Fixtures: `project` (root in tmp with autoApprove/contextFile) and
// `_isolated_user_profile` (USER.md in tmp, never the real ~/.reagent).
//
// test_profile_injected_into_system_prompt and test_remember_registered_as_tool
// depend on system-prompt.ts (phase 6) and tools/index.ts (phase 5): they stay as
// todo until those modules exist; the names are already in the parity map.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { config } from "../src/config.js";
import { buildSystemPrompt } from "../src/system-prompt.js";
import { activeSchemas, REGISTRY } from "../src/tools/index.js";
import { ensure, profileLimits, remember } from "../src/user-profile.js";

const originalRoot = config.root;
const originalProfileFile = config.userProfileFile;
const originalMaxChars = profileLimits.maxChars;
const cleanups: string[] = [];

function mktemp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

beforeEach(() => {
  // _isolated_user_profile: the tests' USER.md goes to a tmp
  config.userProfileFile = path.join(mktemp("reagent-profile-"), "USER.md");
  // project: temporary root with automatic approval and CONTEXT.md off
  const project = mktemp("reagent-project-");
  config.setRoot(project);
  config.autoApprove = true;
  config.contextFile = false;
});

afterEach(() => {
  profileLimits.maxChars = originalMaxChars;
  config.userProfileFile = originalProfileFile;
  config.setRoot(originalRoot);
  while (cleanups.length) {
    fs.rmSync(cleanups.pop() as string, { recursive: true, force: true });
  }
});

describe("user-profile", () => {
  it("test_ensure_creates_template", () => {
    expect(fs.existsSync(config.userProfileFile)).toBe(false);
    ensure();
    const body = fs.readFileSync(config.userProfileFile, "utf8");
    expect(body).toContain("# User profile");
    expect(body).toContain("## Learned preferences");
  });

  it("test_remember_appends_and_dedups", () => {
    expect(remember("prefere type hints em todo lugar").startsWith("Remembered")).toBe(true);
    expect(remember("prefere type hints em todo lugar")).toBe("Already known (no change).");
    const body = fs.readFileSync(config.userProfileFile, "utf8");
    expect(body.split("prefere type hints em todo lugar").length - 1).toBe(1);
    // the fact lands in the learned section
    const learned = body.split("## Learned preferences")[1] as string;
    expect(learned).toContain("- prefere type hints em todo lugar");
  });

  it("test_remember_rejects_empty_and_giant", () => {
    expect(remember("   ").startsWith("Error")).toBe(true);
    expect(remember("x".repeat(500)).startsWith("Error: fact too long")).toBe(true);
  });

  it("test_remember_refuses_when_full", () => {
    profileLimits.maxChars = 300;
    ensure();
    const result = remember("um fato qualquer que nao cabe mais no arquivo");
    expect(result.startsWith("Error: user profile is full")).toBe(true);
  });

  it("test_profile_injected_into_system_prompt", () => {
    remember("nunca usar travessao em textos");
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("User profile");
    expect(prompt).toContain("nunca usar travessao em textos");
  });

  it("test_remember_registered_as_tool", () => {
    expect("remember" in REGISTRY).toBe(true);
    expect(
      activeSchemas().some((s) => (s as { function: { name: string } }).function.name === "remember"),
    ).toBe(true);
  });
});
