// Disk agent definitions (.reagent/agents/*.md): extended frontmatter fields
// disallowed_tools / isolation / background / doom_style, plus legacy compat.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { config } from "../src/config.js";
import { loadDiskAgents } from "../src/agents/load.js";

const originalRoot = config.root;
let project: string;

function writeAgent(name: string, contents: string): void {
  const dir = path.join(config.stateDir, "agents");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.md`), contents);
}

beforeEach(() => {
  project = config.setRoot(fs.mkdtempSync(path.join(os.tmpdir(), "reagent-diskagents-")));
});

afterEach(() => {
  config.setRoot(originalRoot);
  fs.rmSync(project, { recursive: true, force: true });
});

describe("disk agents: extended frontmatter", () => {
  it("supports disallowed_tools, isolation, background and doom_style", () => {
    writeAgent(
      "custom",
      [
        "---",
        "name: custom",
        "description: does custom things",
        "tools: read_file, grep, bash, write_file",
        "disallowed_tools: bash, write_file",
        "isolation: worktree",
        "background: true",
        "doom_style: worker",
        "max_steps: 7",
        "---",
        "You are the custom agent.",
      ].join("\n"),
    );
    const agent = loadDiskAgents().find((a) => a.agentType === "custom");
    expect(agent).toBeDefined();
    expect(agent!.tools).toEqual(["read_file", "grep"]);
    expect(agent!.isolation).toBe("worktree");
    expect(agent!.supportsBackground).toBe(true);
    expect(agent!.doomStyle).toBe("worker");
    expect(agent!.maxSteps).toBe(7);
    expect(agent!.getSystemPrompt()).toBe("You are the custom agent.");
  });

  it("keeps legacy defaults when the new fields are absent", () => {
    writeAgent(
      "legacy",
      ["---", "name: legacy", "description: old style", "---", "Legacy prompt."].join("\n"),
    );
    const agent = loadDiskAgents().find((a) => a.agentType === "legacy");
    expect(agent).toBeDefined();
    expect(agent!.tools).toEqual(["read_file", "list_dir", "glob", "grep"]);
    expect(agent!.isolation).toBe("none");
    expect(agent!.supportsBackground).toBe(false);
    expect(agent!.doomStyle).toBe("none");
    expect(agent!.maxSteps).toBe(12);
  });

  it("ignores invalid isolation / doom_style values", () => {
    writeAgent(
      "weird",
      [
        "---",
        "name: weird",
        "description: bad values",
        "isolation: container",
        "doom_style: chaotic",
        "---",
        "Prompt.",
      ].join("\n"),
    );
    const agent = loadDiskAgents().find((a) => a.agentType === "weird");
    expect(agent!.isolation).toBe("none");
    expect(agent!.doomStyle).toBe("none");
  });

  it("accepts bracketed lists for tools and disallowed_tools", () => {
    writeAgent(
      "bracketed",
      [
        "---",
        "name: bracketed",
        "description: bracket syntax",
        "tools: [read_file, grep, bash]",
        "disallowed_tools: [bash]",
        "---",
        "Prompt.",
      ].join("\n"),
    );
    const agent = loadDiskAgents().find((a) => a.agentType === "bracketed");
    expect(agent!.tools).toEqual(["read_file", "grep"]);
  });
});
