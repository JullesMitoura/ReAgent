// Mirror of tests/test_spill.py: spill of huge outputs (dispatch ->
// .reagent/truncations), reading allowed but writing blocked, cleanup of old
// spills and case-insensitive repair of tool name. Names 1:1 with Python.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MAX_TOOL_OUTPUT, config } from "../src/config.js";
import { REGISTRY, _setTurnOutputBudget, dispatch } from "../src/tools/index.js";
import { ToolError } from "../src/tools/errors.js";
import { readFile, writeFile } from "../src/tools/files.js";
import { newTurnContext, runWithTurn } from "../src/turn-context.js";

const originalRoot = config.root;
let project: string;
const added: string[] = [];

function fakeTool(name: string, fn: () => string): void {
  REGISTRY[name] = fn;
  added.push(name);
}

beforeEach(() => {
  project = config.setRoot(fs.mkdtempSync(path.join(os.tmpdir(), "reagent-spill-")));
  config.autoApprove = true;
  config.contextFile = false;
});

afterEach(() => {
  for (const name of added) delete REGISTRY[name];
  added.length = 0;
  _setTurnOutputBudget(null);
  config.setRoot(originalRoot);
  fs.rmSync(project, { recursive: true, force: true });
});

function spillDir(): string {
  return path.join(config.stateDir, "truncations");
}

describe("spill", () => {
  it("test_oversized_output_spills_to_file", async () => {
    const big = "L".repeat(MAX_TOOL_OUTPUT + 5000);
    fakeTool("fake_big", () => big);
    const out = await dispatch("fake_big", "{}");
    expect(out).toContain("full output saved to");
    expect(out).toContain(String(MAX_TOOL_OUTPUT + 5000)); // reports the total size
    const spills = fs
      .readdirSync(spillDir())
      .filter((f) => f.startsWith("fake_big-") && f.endsWith(".txt"));
    expect(spills.length).toBe(1);
    expect(fs.readFileSync(path.join(spillDir(), spills[0]!), "utf8")).toBe(big); // full
  });

  it("test_small_output_does_not_spill", async () => {
    fakeTool("fake_small", () => "ok");
    expect(await dispatch("fake_small", "{}")).toBe("ok");
    expect(fs.existsSync(spillDir())).toBe(false);
  });

  it("test_spill_file_is_readable_but_not_writable", async () => {
    const big = "M".repeat(MAX_TOOL_OUTPUT + 1000);
    fakeTool("fake_big", () => big);
    await dispatch("fake_big", "{}");
    const name = fs.readdirSync(spillDir()).find((f) => f.startsWith("fake_big-"))!;
    const rel = path.relative(config.root, path.join(spillDir(), name));
    // readable by the file tools (the only exception to the .reagent block)
    expect(readFile(rel)).toContain("M");
    // but never writable: the agent state stays read-only
    await expect(writeFile(rel, "tampered")).rejects.toThrow(ToolError);
  });

  it("test_rest_of_state_dir_remains_blocked", () => {
    expect(() => readFile(".reagent/permissions.json")).toThrow(ToolError);
  });

  it("test_old_spills_are_cleaned_up", async () => {
    fs.mkdirSync(spillDir(), { recursive: true });
    const stale = path.join(spillDir(), "bash-deadbeef.txt");
    fs.writeFileSync(stale, "old");
    const oldTime = Date.now() / 1000 - 8 * 24 * 3600; // older than the 7-day retention
    fs.utimesSync(stale, oldTime, oldTime);
    const big = "N".repeat(MAX_TOOL_OUTPUT + 1000);
    fakeTool("fake_big", () => big);
    await dispatch("fake_big", "{}");
    expect(fs.existsSync(stale)).toBe(false);
  });

  it("test_case_insensitive_tool_name_repair", async () => {
    // models sometimes get the name case wrong; do not waste the round
    const out = await dispatch("List_Dir", "{}");
    expect(out.startsWith("Error: unknown tool")).toBe(false);
    expect(await dispatch("no_such_tool", "{}")).toBe("Error: unknown tool 'no_such_tool'");
  });

  it("test_turn_output_budget_aggressively_truncates", async () => {
    _setTurnOutputBudget(5_000);
    fakeTool("fake_mid", () => "A".repeat(3_000));
    await runWithTurn(newTurnContext(), async () => {
      // first call fits the budget and passes through untouched
      expect(await dispatch("fake_mid", "{}")).toBe("A".repeat(3_000));
      // second call would exceed the 5k turn budget: aggressive head-tail cut
      const second = await dispatch("fake_mid", "{}");
      expect(second).toContain("output aggressively truncated: turn output budget exceeded");
      expect(second).toContain("full output saved to");
      expect(second.length).toBeLessThan(3_000);
      // the full output survives in the spill file
      const spill = fs
        .readdirSync(spillDir())
        .find((f) => f.startsWith("fake_mid-") && f.endsWith(".txt"))!;
      expect(fs.readFileSync(path.join(spillDir(), spill), "utf8")).toBe("A".repeat(3_000));
    });
  });

  it("test_turn_output_budget_lets_small_outputs_through", async () => {
    _setTurnOutputBudget(100);
    fakeTool("fake_tiny", () => "T".repeat(80));
    await runWithTurn(newTurnContext(), async () => {
      // both exceed the aggregate budget, but small outputs are never mangled
      expect(await dispatch("fake_tiny", "{}")).toBe("T".repeat(80));
      expect(await dispatch("fake_tiny", "{}")).toBe("T".repeat(80));
    });
  });

  it("test_turn_output_budget_ignored_outside_a_turn", async () => {
    _setTurnOutputBudget(5_000);
    fakeTool("fake_mid", () => "B".repeat(3_000));
    // no TurnContext: no accumulator, so nothing to exceed
    expect(await dispatch("fake_mid", "{}")).toBe("B".repeat(3_000));
    expect(await dispatch("fake_mid", "{}")).toBe("B".repeat(3_000));
    expect(await dispatch("fake_mid", "{}")).toBe("B".repeat(3_000));
  });
});
