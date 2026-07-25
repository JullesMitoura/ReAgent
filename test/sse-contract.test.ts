// NEW test (does not exist in Python; recommended by the spec, section 5.3):
// brings the app up in-process with a fake agent (llm.chat mocked), runs a turn
// and validates the data-only SSE framing and the catalog/fields of the 13
// events of section 3.3 of MIGRATION_SPEC, cross-checking against the contract
// consumed by the front (code-front/src/types.ts, ServerEvent union, snake_case
// fields).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/system-prompt.js", () => ({ buildSystemPrompt: () => "sys" }));

const hooks = vi.hoisted(() => ({ chatImpl: null as null | (() => unknown) }));

vi.mock("../src/llm/client.js", () => ({
  chat: () => (hooks.chatImpl ? hooks.chatImpl() : []),
  getClient: () => {
    throw new Error("no llm client in tests");
  },
}));

import { config } from "../src/config.js";
import { createApp } from "../src/server/app.js";

// Catalog of the 13 event types (section 3.3). The front switches on .type; a
// type outside this set would be silently ignored by the UI.
const KNOWN_TYPES = new Set([
  "token",
  "status",
  "usage",
  "tool_start",
  "tool_end",
  "todos",
  "permission_request",
  "question_request",
  "agents_start",
  "agent_update",
  "agents_end",
  "error",
  "done",
]);

const originalRoot = config.root;
let project: string;

beforeEach(() => {
  project = config.setRoot(fs.mkdtempSync(path.join(os.tmpdir(), "reagent-sse-")));
  config.autoApprove = true;
  config.contextFile = false;
  hooks.chatImpl = null;
});

afterEach(() => {
  config.setRoot(originalRoot);
  fs.rmSync(project, { recursive: true, force: true });
});

interface SseEvent {
  type: string;
  [key: string]: unknown;
}

// Round 1: one todowrite tool call (exercises tool_start/tool_end/todos + usage).
// Round 2: final text (exercises token + done). cached_tokens exercises the
// cached_prompt_tokens field of the usage event.
function todoStream(): unknown[] {
  const args = JSON.stringify({ todos: [{ content: "write the report", status: "completed" }] });
  const tc = { index: 0, id: "t0", function: { name: "todowrite", arguments: args } };
  return [
    { choices: [{ delta: { content: null, tool_calls: [tc] }, finish_reason: null }], usage: null },
    {
      choices: [{ delta: { content: null, tool_calls: null }, finish_reason: "tool_calls" }],
      usage: {
        prompt_tokens: 5,
        completion_tokens: 1,
        prompt_tokens_details: { cached_tokens: 3 },
      },
    },
  ];
}

function finalStream(text: string): unknown[] {
  return [
    { choices: [{ delta: { content: text, tool_calls: null }, finish_reason: null }], usage: null },
    {
      choices: [{ delta: { content: null, tool_calls: null }, finish_reason: "stop" }],
      usage: { prompt_tokens: 7, completion_tokens: 2 },
    },
  ];
}

async function runTurn(): Promise<{ raw: string; events: SseEvent[] }> {
  const app = createApp();
  const created = (await (
    await app.fetch(new Request("http://localhost/api/sessions", { method: "POST" }))
  ).json()) as { id: string };
  const resp = await app.fetch(
    new Request(`http://localhost/api/sessions/${created.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "hi" }),
    }),
  );
  expect(resp.status).toBe(200);
  expect(resp.headers.get("content-type")).toMatch(/^text\/event-stream/);
  const raw = await resp.text();
  const events = raw
    .split("\n\n")
    .filter((f) => f.length > 0)
    .map((f) => JSON.parse(f.slice(6)) as SseEvent);
  return { raw, events };
}

describe("sse contract", () => {
  it("test_sse_framing_is_data_only", async () => {
    let calls = 0;
    hooks.chatImpl = () => {
      calls += 1;
      return calls === 1 ? todoStream() : finalStream("all done");
    };
    const { raw } = await runTurn();

    // each frame is exactly "data: <json>\n\n"; without event:/id:/retry:.
    expect(raw.length).toBeGreaterThan(0);
    const frames = raw.split("\n\n").filter((f) => f.length > 0);
    for (const frame of frames) {
      expect(frame.startsWith("data: ")).toBe(true);
      expect(frame.includes("\n")).toBe(false); // single-line json
      expect(() => JSON.parse(frame.slice(6))).not.toThrow();
    }
    // ends with the frame separator (\n\n after the last event)
    expect(raw.endsWith("\n\n")).toBe(true);
    expect(/^event:/m.test(raw)).toBe(false);
    expect(/^id:/m.test(raw)).toBe(false);
    expect(/^retry:/m.test(raw)).toBe(false);
  });

  it("test_sse_event_catalog_and_fields", async () => {
    let calls = 0;
    hooks.chatImpl = () => {
      calls += 1;
      return calls === 1 ? todoStream() : finalStream("all done");
    };
    const { events } = await runTurn();

    // every event belongs to the catalog of 13 types
    for (const ev of events) {
      expect(KNOWN_TYPES.has(ev.type)).toBe(true);
    }

    // the fake turn exercises this subset
    const seen = new Set(events.map((e) => e.type));
    for (const t of ["usage", "tool_start", "tool_end", "todos", "token", "done"]) {
      expect(seen.has(t)).toBe(true);
    }

    // fields per type (snake_case, as the front consumes in types.ts)
    for (const ev of events) {
      switch (ev.type) {
        case "token":
          expect(typeof ev.text).toBe("string");
          break;
        case "status":
          expect(typeof ev.text).toBe("string");
          break;
        case "usage":
          expect(typeof ev.prompt_tokens).toBe("number");
          expect(typeof ev.completion_tokens).toBe("number");
          expect(typeof ev.last_prompt_tokens).toBe("number");
          expect(typeof ev.cached_prompt_tokens).toBe("number");
          expect(typeof ev.context_window).toBe("number");
          break;
        case "tool_start":
          expect(typeof ev.id).toBe("string");
          expect(typeof ev.name).toBe("string");
          expect(typeof ev.args).toBe("string");
          expect((ev.args as string).length).toBeLessThanOrEqual(200);
          break;
        case "tool_end":
          expect(typeof ev.id).toBe("string");
          expect(typeof ev.result).toBe("string");
          expect((ev.result as string).length).toBeLessThanOrEqual(3000);
          break;
        case "todos":
          expect(Array.isArray(ev.todos)).toBe(true);
          for (const t of ev.todos as { content: string; status: string }[]) {
            expect(typeof t.content).toBe("string");
            expect(typeof t.status).toBe("string");
          }
          break;
        case "done":
          expect(typeof ev.content).toBe("string");
          break;
        default:
          break;
      }
    }

    // the accumulated usage carries the prefix cache from the first round
    const usages = events.filter((e) => e.type === "usage");
    expect(usages.length).toBeGreaterThan(0);
    expect(usages[0]!.cached_prompt_tokens).toBe(3);

    // the todos reflects the full list written by todowrite
    const todos = events.find((e) => e.type === "todos");
    expect(todos).toBeDefined();
    expect((todos!.todos as unknown[]).length).toBe(1);

    // last event is the normal done with the final text
    const last = events[events.length - 1]!;
    expect(last.type).toBe("done");
    expect(last.content).toBe("all done");
    expect(last.aborted).toBeUndefined();
  });
});
