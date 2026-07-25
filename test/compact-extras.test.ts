// Compaction extras: post-compact re-injection of recently read files and the
// summarize-failure circuit breaker (skip straight to hardTruncate after 3
// consecutive failures in the same session).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/system-prompt.js", () => ({ buildSystemPrompt: () => "sys" }));

vi.mock("../src/llm/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/llm/client.js")>();
  return { ...actual, chat: vi.fn(actual.chat) };
});

import { recordRead, resetReadState } from "../src/agent/read-state.js";
import {
  compactSession,
  filesReadReminder,
  resetCompactFailures,
} from "../src/agent/compact.js";
import { config } from "../src/config.js";
import { chat } from "../src/llm/client.js";
import { Session } from "../src/session.js";
import type { ChatMessage } from "../src/types.js";

const originalRoot = config.root;
const savedKeepLast = config.compactKeepLast;
let project: string;

beforeEach(() => {
  project = config.setRoot(fs.mkdtempSync(path.join(os.tmpdir(), "reagent-cext-")));
  config.contextFile = false;
  config.compactKeepLast = 2;
  resetReadState();
  resetCompactFailures();
});

afterEach(() => {
  vi.mocked(chat).mockReset();
  config.compactKeepLast = savedKeepLast;
  config.setRoot(originalRoot);
  fs.rmSync(project, { recursive: true, force: true });
});

function fakeResponse(content: string): { choices: { message: { content: string } }[] } {
  return { choices: [{ message: { content } }] };
}

function longHistory(): ChatMessage[] {
  const msgs: ChatMessage[] = [{ role: "system", content: "sys" }];
  for (let i = 0; i < 15; i++) {
    msgs.push({ role: "user", content: `u${i} ` + "x".repeat(500) });
    msgs.push({ role: "assistant", content: `a${i}` });
  }
  return msgs;
}

function readFixture(name: string, content: string): string {
  const p = path.join(project, name);
  fs.writeFileSync(p, content);
  recordRead(p);
  return p;
}

describe("compact-extras", () => {
  // --- post-compact re-injection of recently read files -----------------------

  it("filesReadReminder truncates each file and caps at 5 files", () => {
    const paths: string[] = [];
    for (let i = 0; i < 6; i++) {
      paths.push(readFixture(`f${i}.txt`, `file ${i} ` + "y".repeat(8000)));
    }
    const msg = filesReadReminder()!;
    expect(msg.role).toBe("user");
    const content = msg.content as string;
    expect(
      content.startsWith("<system-reminder>Files read before compaction (truncated):"),
    ).toBe(true);
    expect(content.endsWith("</system-reminder>")).toBe(true);
    // 5 most recent (f1..f5), oldest (f0) dropped
    for (const p of paths.slice(1)) expect(content).toContain(p);
    expect(content).not.toContain(paths[0]!);
    // each file clipped to ~5000 chars, so the whole block stays bounded
    expect(content.length).toBeLessThan(27_000);
    expect(content).toContain("chars omitted");
  });

  it("filesReadReminder is null with no reads or only deleted files", () => {
    expect(filesReadReminder()).toBeNull();
    const p = readFixture("gone.txt", "bye");
    fs.rmSync(p);
    expect(filesReadReminder()).toBeNull();
  });

  it("compactSession re-injects recently read files after the summary", async () => {
    vi.mocked(chat).mockImplementation(async () => fakeResponse("DENSE SUMMARY") as never);
    const p = readFixture("src.ts", "export const answer = 42;\n");

    const session = new Session({ id: "cext-reinject", messages: longHistory() });
    await compactSession(session);

    const joined = session.messages.map((m) => String(m.content ?? "")).join("\n");
    expect(joined).toContain("DENSE SUMMARY");
    const reminder = session.messages.find(
      (m) =>
        m.role === "user" &&
        String(m.content ?? "").startsWith("<system-reminder>Files read before compaction"),
    );
    expect(reminder).toBeDefined();
    expect(reminder!.content).toContain(p);
    expect(reminder!.content).toContain("export const answer = 42;");
  });

  // --- circuit breaker ---------------------------------------------------------

  it("after 3 consecutive summarize failures it skips the model entirely", async () => {
    vi.mocked(chat).mockImplementation(async () => {
      throw new Error("boom");
    });

    const session = new Session({ id: "cext-breaker", messages: longHistory() });
    for (let i = 0; i < 3; i++) {
      session.messages = longHistory();
      await compactSession(session);
    }
    expect(vi.mocked(chat).mock.calls.length).toBe(3); // one failed attempt each

    session.messages = longHistory();
    await compactSession(session);
    expect(vi.mocked(chat).mock.calls.length).toBe(3); // circuit open: no new call
    expect(session.messages.length).toBeLessThan(longHistory().length); // still hard-truncates
  });

  it("a successful summary closes the circuit again", async () => {
    let calls = 0;
    vi.mocked(chat).mockImplementation(async () => {
      calls += 1;
      if (calls <= 2) throw new Error("boom");
      return fakeResponse("RECOVERED SUMMARY") as never;
    });

    const session = new Session({ id: "cext-recover", messages: longHistory() });
    for (let i = 0; i < 3; i++) {
      session.messages = longHistory();
      await compactSession(session); // fail, fail, success
    }
    const joined = session.messages.map((m) => String(m.content ?? "")).join("\n");
    expect(joined).toContain("RECOVERED SUMMARY");

    // counter was reset: the next compaction still consults the model
    session.messages = longHistory();
    await compactSession(session);
    expect(calls).toBe(4);
  });

  it("failures are counted per session", async () => {
    vi.mocked(chat).mockImplementation(async () => {
      throw new Error("boom");
    });
    const a = new Session({ id: "cext-a", messages: longHistory() });
    for (let i = 0; i < 3; i++) {
      a.messages = longHistory();
      await compactSession(a);
    }
    const before = vi.mocked(chat).mock.calls.length;

    const b = new Session({ id: "cext-b", messages: longHistory() });
    await compactSession(b); // different session: circuit closed, model consulted
    expect(vi.mocked(chat).mock.calls.length).toBe(before + 1);
  });
});
