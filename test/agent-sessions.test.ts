// Subagent session persistence: sessions written to .reagent/agent-sessions/
// survive a "restart" (memory clear), are lazily loaded on lookup/list, and
// stale files are swept after 7 days.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { config } from "../src/config.js";
import {
  clearAgentSessions,
  getAgentSession,
  listAgentSessions,
  registerAgentSession,
  type AgentSession,
} from "../src/agents/sessions.js";

const originalRoot = config.root;
let project: string;

function sessionsDir(): string {
  return path.join(config.stateDir, "agent-sessions");
}

function fakeSession(id: string, overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id,
    agentType: "explore",
    title: "test agent",
    messages: [
      { role: "system", content: "you are a test agent" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "report: done" },
    ],
    allowedTools: new Set(["read_file", "grep"]),
    maxSteps: 12,
    forceSummary: "wrap up",
    emptyResult: "(no report)",
    doomStyle: "none",
    status: "completed",
    updatedAt: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  project = config.setRoot(fs.mkdtempSync(path.join(os.tmpdir(), "reagent-agentsess-")));
  clearAgentSessions();
});

afterEach(() => {
  config.setRoot(originalRoot);
  clearAgentSessions();
  fs.rmSync(project, { recursive: true, force: true });
});

describe("agent session persistence", () => {
  it("registerAgentSession writes <id>.json under .reagent/agent-sessions", () => {
    registerAgentSession(fakeSession("agent-abc-123"));
    const file = path.join(sessionsDir(), "agent-abc-123.json");
    expect(fs.existsSync(file)).toBe(true);
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(data.agentType).toBe("explore");
    expect(data.allowedTools).toEqual(["read_file", "grep"]);
    expect(Array.isArray(data.messages)).toBe(true);
    expect(data.messages.length).toBe(3);
  });

  it("getAgentSession reloads from disk after a restart (memory clear)", () => {
    registerAgentSession(fakeSession("agent-persisted-1"));
    clearAgentSessions();
    const loaded = getAgentSession("agent-persisted-1");
    expect(loaded).toBeDefined();
    expect(loaded!.agentType).toBe("explore");
    expect(loaded!.title).toBe("test agent");
    expect(loaded!.status).toBe("completed");
    expect(loaded!.messages[2]).toMatchObject({ role: "assistant", content: "report: done" });
    expect(loaded!.allowedTools).toBeInstanceOf(Set);
    expect([...loaded!.allowedTools].sort()).toEqual(["grep", "read_file"]);
  });

  it("listAgentSessions merges disk-only sessions with in-memory ones", () => {
    registerAgentSession(fakeSession("agent-old-run", { updatedAt: Date.now() - 1000 }));
    clearAgentSessions();
    registerAgentSession(fakeSession("agent-new-run"));
    const ids = listAgentSessions().map((s) => s.id);
    expect(ids).toEqual(["agent-new-run", "agent-old-run"]);
  });

  it("unknown or path-unsafe ids return undefined", () => {
    expect(getAgentSession("agent-nope")).toBeUndefined();
    expect(getAgentSession("../../etc/passwd")).toBeUndefined();
  });

  it("corrupt persisted files are ignored", () => {
    fs.mkdirSync(sessionsDir(), { recursive: true });
    fs.writeFileSync(path.join(sessionsDir(), "agent-corrupt.json"), "{not json");
    expect(getAgentSession("agent-corrupt")).toBeUndefined();
    expect(listAgentSessions()).toEqual([]);
  });

  it("files older than 7 days are swept on first access", () => {
    fs.mkdirSync(sessionsDir(), { recursive: true });
    const stale = path.join(sessionsDir(), "agent-stale.json");
    const fresh = path.join(sessionsDir(), "agent-fresh.json");
    const serialize = (s: AgentSession) =>
      JSON.stringify({ ...s, allowedTools: [...s.allowedTools] });
    fs.writeFileSync(stale, serialize(fakeSession("agent-stale")));
    fs.writeFileSync(fresh, serialize(fakeSession("agent-fresh")));
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    fs.utimesSync(stale, eightDaysAgo, eightDaysAgo);

    const ids = listAgentSessions().map((s) => s.id);
    expect(ids).toEqual(["agent-fresh"]);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });
});
