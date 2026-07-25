// 1:1 mirror of tests/test_permissions.py. Python's no_auto_approve fixture
// (project + AUTO_APPROVE=false) becomes the beforeEach below. Python's global
// ask_handler becomes permissionHandler in the TurnContext.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { config } from "../src/config.js";
import * as permissions from "../src/permissions.js";
import { newTurnContext, runWithTurn } from "../src/turn-context.js";
import type { PermissionHandler } from "../src/turn-context.js";

const originalRoot = config.root;
let project: string;

beforeEach(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), "reagent-perm-"));
  config.setRoot(project);
  config.autoApprove = false;
  config.contextFile = false;
});

afterEach(() => {
  config.setRoot(originalRoot);
  fs.rmSync(project, { recursive: true, force: true });
});

describe("permissions", () => {
  it("test_bash_rule_prefix_matches", async () => {
    permissions.saveRule("bash", "git status");
    expect(await permissions.confirmBash("git status -sb")).toBe(true);
    // non-tty denies
    expect(await permissions.confirmBash("git push origin main")).toBe(false);
  });

  it("test_bash_rule_does_not_leak_by_substring", async () => {
    permissions.saveRule("bash", "ls");
    expect(await permissions.confirmBash("lsof -i")).toBe(false);
  });

  it("test_file_rule_glob", async () => {
    permissions.saveRule("write", "src/**");
    expect(await permissions.confirmFile("write", "create x", "src/deep/x.py")).toBe(true);
    expect(await permissions.confirmFile("write", "create y", "other/y.py")).toBe(false);
  });

  it("test_bash_suggestion", () => {
    expect(permissions.bashRuleSuggestion("git push origin")).toBe("git push");
    expect(permissions.bashRuleSuggestion("ls -la")).toBe("ls");
  });

  it("test_ask_handler_hook_always_saves_rule", async () => {
    const calls: [string, string][] = [];
    const handler: PermissionHandler = async (kind, _action, _preview, suggestion) => {
      calls.push([kind, suggestion]);
      return "always";
    };
    const ctx = newTurnContext({ permissionHandler: handler });
    // npm is not in the read-only command safelist, so it goes through the handler
    // (cat/ls/git status are now auto-approved by isSafeCommand).
    // "npm install": "npm run" became a banned suggestion (runs an arbitrary script).
    expect(await runWithTurn(ctx, () => permissions.confirmBash("npm install left-pad"))).toBe(
      true,
    );
    expect(calls).toEqual([["bash", "npm install"]]);
    // persisted rule: the next call does not consult the handler
    expect(await permissions.confirmBash("npm install foo")).toBe(true);
  });

  it("test_ask_handler_deny", async () => {
    const ctx = newTurnContext({ permissionHandler: async () => "deny" as const });
    expect(await runWithTurn(ctx, () => permissions.confirmBash("rm -rf x"))).toBe(false);
  });

  // --- banned prefixes for "always allow" ------------------------------------

  it("test_banned_suggestion_no_always", async () => {
    const suggestions: string[] = [];
    const handler: PermissionHandler = async (_kind, _action, _preview, suggestion) => {
      suggestions.push(suggestion);
      return "always";
    };
    const ctx = newTurnContext({ permissionHandler: handler });
    // sudo is a banned prefix: approves the single run, but without a rule.
    expect(await runWithTurn(ctx, () => permissions.confirmBash("sudo whoami"))).toBe(true);
    expect(suggestions).toEqual([""]); // empty suggestion: the front does not offer "always"
    expect(permissions.loadRules().bash).toEqual([]);
    // with no saved rule, the next call consults the handler again
    expect(await runWithTurn(ctx, () => permissions.confirmBash("sudo whoami"))).toBe(true);
    expect(suggestions.length).toBe(2);
  });

  it("test_migration_removes_banned_rules", () => {
    fs.mkdirSync(config.stateDir, { recursive: true });
    fs.writeFileSync(config.permissionsFile, '{"bash": ["bash", "git status"]}');
    const rules = permissions.loadRules();
    expect(rules.bash).not.toContain("bash");
    expect(rules.bash).toContain("git status");
    const marker = path.join(config.stateDir, "permissions_migrated");
    expect(fs.existsSync(marker)).toBe(true);
    // second call does not reprocess: a banned rule reinserted by hand survives
    fs.writeFileSync(config.permissionsFile, '{"bash": ["bash"]}');
    expect(permissions.loadRules().bash).toEqual(["bash"]);
  });

  it("test_save_rule_refuses_banned", () => {
    permissions.saveRule("bash", "sudo");
    expect(permissions.loadRules().bash).toEqual([]);
  });

  // --- cancellation and timeout distinct from denial -------------------------

  it("test_ask_handler_cancelled_nega_com_mensagem_propria", async () => {
    const ctx = newTurnContext({ permissionHandler: async () => "cancelled" as const });
    expect(await runWithTurn(ctx, () => permissions.confirmBash("npm install x"))).toBe(false);
    const msg = runWithTurn(ctx, () =>
      permissions.denialMessage("User denied command execution."),
    );
    expect(msg).toContain("interrupted");
    expect(msg).not.toContain("User denied");
    expect(permissions.loadRules().bash).toEqual([]); // no rule persisted
  });

  it("test_ask_handler_timeout_nega_com_ask_again_later", async () => {
    const ctx = newTurnContext({ permissionHandler: async () => "timeout" as const });
    expect(await runWithTurn(ctx, () => permissions.confirmBash("npm install x"))).toBe(false);
    const msg = runWithTurn(ctx, () =>
      permissions.denialMessage("User denied command execution."),
    );
    expect(msg).toContain("ask again later");
    expect(msg).not.toContain("User denied");
    expect(permissions.loadRules().bash).toEqual([]);
  });

  it("test_denial_message_deny_usa_o_default", async () => {
    const ctx = newTurnContext({ permissionHandler: async () => "deny" as const });
    expect(await runWithTurn(ctx, () => permissions.confirmBash("npm install x"))).toBe(false);
    const msg = runWithTurn(ctx, () =>
      permissions.denialMessage("User denied command execution."),
    );
    expect(msg).toBe("User denied command execution.");
  });

  it("test_denial_message_e_consumida_uma_vez", async () => {
    const ctx = newTurnContext({ permissionHandler: async () => "timeout" as const });
    await runWithTurn(ctx, () => permissions.confirmBash("npm install x"));
    expect(runWithTurn(ctx, () => permissions.denialMessage("default"))).toContain(
      "ask again later",
    );
    // second read returns to the default: the state does not leak to the next tool
    expect(runWithTurn(ctx, () => permissions.denialMessage("default"))).toBe("default");
  });

  it("test_dangerous_sob_yolo_explica_na_denial_message", async () => {
    config.autoApprove = true;
    config.allowDangerous = false;
    expect(await permissions.confirmBash("rm -rf build")).toBe(false);
    expect(permissions.denialMessage("User denied command execution.")).toContain(
      "--allow-dangerous",
    );
  });
});
