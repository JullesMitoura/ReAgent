// 1:1 mirror of tests/test_permissions_ops.py: shell operators never let a
// prefix rule auto-approve a compound command.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { config } from "../src/config.js";
import * as permissions from "../src/permissions.js";

const originalRoot = config.root;
let project: string;

beforeEach(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), "reagent-perm-ops-"));
  config.setRoot(project);
  config.autoApprove = false;
  config.contextFile = false;
});

afterEach(() => {
  config.setRoot(originalRoot);
  fs.rmSync(project, { recursive: true, force: true });
});

describe("permissions_ops", () => {
  it("test_has_shell_operators_detects_control_chars", () => {
    expect(permissions.hasShellOperators("git status && rm -rf x")).toBe(true);
    expect(permissions.hasShellOperators("git status; cat .env")).toBe(true);
    expect(permissions.hasShellOperators("git status | grep foo")).toBe(true);
    expect(permissions.hasShellOperators("echo $(cat .env)")).toBe(true);
    expect(permissions.hasShellOperators("cat < file")).toBe(true);
    expect(permissions.hasShellOperators("echo hi > out.txt")).toBe(true);
    expect(permissions.hasShellOperators("echo `id`")).toBe(true);
    expect(permissions.hasShellOperators("git status\ncat .env")).toBe(true);
  });

  it("test_has_shell_operators_unbalanced_quotes", () => {
    // Unbalanced quotes: tokenize fails, we treat it as an operator present.
    expect(permissions.hasShellOperators('git status "oops')).toBe(true);
  });

  it("test_has_shell_operators_plain_command_false", () => {
    expect(permissions.hasShellOperators("git status -sb")).toBe(false);
    expect(permissions.hasShellOperators("ls -la")).toBe(false);
  });

  it("test_prefix_rule_does_not_authorize_compound_and", async () => {
    permissions.saveRule("bash", "git status");
    // A prefix rule cannot authorize a compound command: denies in non-tty.
    expect(await permissions.confirmBash("git status && rm -rf x")).toBe(false);
  });

  it("test_prefix_rule_does_not_authorize_semicolon", async () => {
    permissions.saveRule("bash", "git status");
    expect(await permissions.confirmBash("git status; cat .env")).toBe(false);
  });

  it("test_prefix_rule_still_approves_plain_command", async () => {
    permissions.saveRule("bash", "git status");
    expect(await permissions.confirmBash("git status -sb")).toBe(true);
  });
});
