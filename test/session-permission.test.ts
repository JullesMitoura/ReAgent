// Session-scoped permission rules: "allow for session" must auto-approve
// matching actions for the rest of the process session without writing
// permissions.json.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { config } from "../src/config.js";
import { confirmBash, confirmFile, saveSessionRule } from "../src/permissions.js";
import { Session } from "../src/session.js";
import { newTurnContext, runWithTurn } from "../src/turn-context.js";

const originalRoot = config.root;
const originalAuto = config.autoApprove;
let project: string;

beforeEach(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), "reagent-sessperm-"));
  config.setRoot(project);
  config.autoApprove = false;
});

afterEach(() => {
  config.autoApprove = originalAuto;
  config.setRoot(originalRoot);
  fs.rmSync(project, { recursive: true, force: true });
});

describe("session-scoped permissions", () => {
  it("auto-approves bash after saveSessionRule without touching permissions.json", async () => {
    const session = Session.new();
    await runWithTurn(newTurnContext({ sessionPermissions: session }), async () => {
      saveSessionRule("bash", "npm test");
      expect(await confirmBash("npm test")).toBe(true);
      expect(await confirmBash("npm test -- --watch")).toBe(true);
    });
    expect(fs.existsSync(config.permissionsFile)).toBe(false);
    expect(session.sessionRules.bash).toContain("npm test");
  });

  it("auto-approves file edits matching a session glob", async () => {
    const session = Session.new();
    await runWithTurn(newTurnContext({ sessionPermissions: session }), async () => {
      saveSessionRule("edit", "src/**");
      expect(await confirmFile("edit", "edit src/a.ts", "src/a.ts", null)).toBe(true);
      // Outside the glob still needs a prompt; without a TTY handler it denies.
      expect(await confirmFile("edit", "edit other.ts", "other.ts", null)).toBe(false);
    });
  });

  it("does not leak session rules across sessions", async () => {
    const a = Session.new();
    const b = Session.new();
    await runWithTurn(newTurnContext({ sessionPermissions: a }), async () => {
      saveSessionRule("bash", "cargo test");
      expect(await confirmBash("cargo test")).toBe(true);
    });
    await runWithTurn(newTurnContext({ sessionPermissions: b }), async () => {
      expect(await confirmBash("cargo test")).toBe(false);
    });
  });
});
