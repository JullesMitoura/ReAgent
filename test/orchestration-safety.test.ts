// Unit tests for the orchestration-safety additions:
//  - argument-aware concurrency safety for the `agent` tool (write-capable agents
//    serialize; read-only agents and background launches parallelize),
//  - the structured_output final-report contract for sub-agents.
//
// Pure functions, no network / no mocks.

import { describe, expect, it } from "vitest";

import {
  getToolMeta,
  isCallConcurrencySafe,
  isConcurrencySafe,
  partitionToolBatches,
} from "../src/tools/orchestration.js";
import { structuredOutput, structuredStatusIsError } from "../src/tools/structured-output.js";
import type { ToolCall } from "../src/types.js";

function agentCall(id: string, subagentType: string, extra: Record<string, unknown> = {}): ToolCall {
  return {
    id,
    type: "function",
    function: { name: "agent", arguments: JSON.stringify({ subagent_type: subagentType, ...extra }) },
  };
}

describe("isCallConcurrencySafe", () => {
  it("defers to name-level metadata for non-agent tools", () => {
    expect(isCallConcurrencySafe("read_file", "{}")).toBe(true);
    expect(isCallConcurrencySafe("write_file", "{}")).toBe(false);
    expect(isCallConcurrencySafe("parallel_agents", "{}")).toBe(false);
  });

  it("parallelizes read-only agent types", () => {
    for (const t of ["explore", "plan", "verification"]) {
      expect(isCallConcurrencySafe("agent", JSON.stringify({ subagent_type: t }))).toBe(true);
    }
  });

  it("serializes write-capable agent types", () => {
    for (const t of ["general-purpose", "coordinator-worker", "worker", "some-disk-agent"]) {
      expect(isCallConcurrencySafe("agent", JSON.stringify({ subagent_type: t }))).toBe(false);
    }
  });

  it("treats background launches as safe (they return an immediate ack)", () => {
    const args = JSON.stringify({ subagent_type: "general-purpose", background: true });
    expect(isCallConcurrencySafe("agent", args)).toBe(true);
  });

  it("fails closed on unparseable arguments", () => {
    expect(isCallConcurrencySafe("agent", "{not json")).toBe(false);
  });

  it("task_output is safe read-only; task_stop is serialized", () => {
    expect(getToolMeta("task_output").isReadOnly).toBe(true);
    expect(isConcurrencySafe("task_output")).toBe(true);
    expect(getToolMeta("task_stop").isReadOnly).toBeUndefined();
    expect(isConcurrencySafe("task_stop")).toBe(false);
  });
});

describe("partitionToolBatches with agents", () => {
  it("batches consecutive read-only agents and isolates a write-capable one", () => {
    const calls = [
      agentCall("a1", "explore"),
      agentCall("a2", "plan"),
      agentCall("a3", "general-purpose"),
    ];
    const batches = partitionToolBatches(calls);
    // [explore, plan] run together; general-purpose is its own serial batch.
    expect(batches.map((b) => b.map((c) => c.id))).toEqual([["a1", "a2"], ["a3"]]);
  });
});

describe("structuredOutput", () => {
  it("formats status, summary, files, and details", () => {
    const out = structuredOutput({
      status: "done",
      summary: "Added the null check",
      files_changed: ["src/auth/validate.ts", " "],
      details: "validate.ts:42 now returns 401",
    });
    expect(out).toBe(
      "[done] Added the null check\nfiles: src/auth/validate.ts\n\nvalidate.ts:42 now returns 401",
    );
  });

  it("normalizes unknown status to done and defaults an empty summary", () => {
    expect(structuredOutput({ status: "weird", summary: "" })).toBe("[done] (no summary)");
  });

  it("detects failed/blocked as error status, done as not", () => {
    expect(structuredStatusIsError("[failed] boom")).toBe(true);
    expect(structuredStatusIsError("[blocked] needs a decision")).toBe(true);
    expect(structuredStatusIsError("[done] all good")).toBe(false);
    expect(structuredStatusIsError("plain report")).toBe(false);
  });
});
