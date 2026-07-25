// End-to-end coverage for the permission-approval HTTP flow: POST
// /api/permissions/:pid (src/server/app.ts). test/abort.test.ts only exercises
// the *timeout* path (via SSE, nobody answers) and test/permissions.test.ts
// only tests the pure logic with a mocked handler injected directly into a
// TurnContext, never through HTTP. Neither confirms that answering the real
// endpoint while a turn is mid-flight actually unblocks the waiting tool call.
//
// Same setup as test/abort.test.ts / test/sse-contract.test.ts: createApp()
// with only src/llm/client.js mocked (dispatch stays real, so write_file
// really executes once approved). The turn's SSE stream is read incrementally
// (not with a single res.text()) so the permission_request event's id can be
// captured and answered *while the stream is still open*, mirroring how a
// real front-end reacts to the event before the turn finishes.

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
import { Session } from "../src/session.js";
import { createApp } from "../src/server/app.js";

const originalRoot = config.root;
let project: string;

beforeEach(() => {
  project = config.setRoot(fs.mkdtempSync(path.join(os.tmpdir(), "reagent-perm-e2e-")));
  config.autoApprove = false; // a real permission_request must be raised
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

// Fake stream requesting write_file (triggers a permission_request since
// autoApprove is off in this suite).
function writeCallStream(fileArgs: { path: string; content: string }): unknown[] {
  const tc = { index: 0, id: "c1", function: { name: "write_file", arguments: JSON.stringify(fileArgs) } };
  return [
    { choices: [{ delta: { content: null, tool_calls: [tc] }, finish_reason: null }], usage: null },
    {
      choices: [{ delta: { content: null, tool_calls: null }, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    },
  ];
}

function finalStream(text: string): unknown[] {
  return [
    { choices: [{ delta: { content: text, tool_calls: null }, finish_reason: null }], usage: null },
    {
      choices: [{ delta: { content: null, tool_calls: null }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    },
  ];
}

/** Incrementally reads "data: <json>\n\n" SSE frames off a streaming Response. */
function frameReader(resp: Response): { next(): Promise<SseEvent | null> } {
  const reader = resp.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    async next(): Promise<SseEvent | null> {
      for (;;) {
        const idx = buffer.indexOf("\n\n");
        if (idx !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          if (frame.length === 0) continue;
          return JSON.parse(frame.slice(6)) as SseEvent;
        }
        const { value, done } = await reader.read();
        if (done) return null;
        buffer += decoder.decode(value, { stream: true });
      }
    },
  };
}

async function createSession(app: ReturnType<typeof createApp>): Promise<string> {
  const created = (await (
    await app.fetch(new Request("http://localhost/api/sessions", { method: "POST" }))
  ).json()) as { id: string };
  return created.id;
}

describe("permission approval e2e", () => {
  it("test_permission_approval_over_http_unblocks_the_tool_and_completes_the_turn", async () => {
    let calls = 0;
    hooks.chatImpl = () => {
      calls += 1;
      return calls === 1
        ? writeCallStream({ path: "greeting.txt", content: "hello e2e" })
        : finalStream("done writing");
    };

    const app = createApp();
    const sid = await createSession(app);

    const resp = await app.fetch(
      new Request(`http://localhost/api/sessions/${sid}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "write it" }),
      }),
    );
    expect(resp.status).toBe(200);

    const stream = frameReader(resp);
    const seen: SseEvent[] = [];
    let permissionId: string | null = null;
    for (;;) {
      const ev = await stream.next();
      if (ev === null) break;
      seen.push(ev);
      if (ev.type === "permission_request") {
        permissionId = ev.id as string;
        break;
      }
    }
    expect(permissionId).not.toBeNull();
    const permEvent = seen.find((e) => e.type === "permission_request")!;
    expect(permEvent.kind).toBe("write");
    expect(String(permEvent.action)).toContain("greeting.txt");

    // Answer the pending permission over HTTP WHILE the turn's stream is
    // still open (the file must not exist yet: the write only happens once
    // the tool is unblocked below).
    expect(fs.existsSync(path.join(config.root, "greeting.txt"))).toBe(false);
    const approveResp = await app.fetch(
      new Request(`http://localhost/api/permissions/${permissionId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answer: "once" }),
      }),
    );
    expect(approveResp.status).toBe(200);
    expect(await approveResp.json()).toEqual({ ok: true });

    // Drain the rest of the stream to the end.
    for (;;) {
      const ev = await stream.next();
      if (ev === null) break;
      seen.push(ev);
    }

    const toolEnd = seen.find((e) => e.type === "tool_end");
    expect(toolEnd).toBeDefined();
    expect(String(toolEnd!.result)).toContain("greeting.txt");

    const doneEvents = seen.filter((e) => e.type === "done");
    expect(doneEvents.length).toBeGreaterThan(0);
    const last = doneEvents[doneEvents.length - 1]!;
    expect(last.aborted).toBeUndefined();
    expect(last.content).toBe("done writing");

    // The tool actually executed: real filesystem effect.
    expect(fs.existsSync(path.join(config.root, "greeting.txt"))).toBe(true);
    expect(fs.readFileSync(path.join(config.root, "greeting.txt"), "utf8")).toBe("hello e2e");

    // The turn completed and persisted: session messages reflect the write.
    const msgs = Session.load(sid).messages;
    const toolMsgs = msgs.filter((m) => m.role === "tool");
    expect(toolMsgs.some((m) => String(m.content).includes("greeting.txt"))).toBe(true);
    expect(msgs[msgs.length - 1]).toEqual({ role: "assistant", content: "done writing" });
  });

  it("test_permission_denial_over_http_blocks_the_tool_without_writing", async () => {
    let calls = 0;
    hooks.chatImpl = () => {
      calls += 1;
      return calls === 1
        ? writeCallStream({ path: "denied.txt", content: "should not land" })
        : finalStream("could not write");
    };

    const app = createApp();
    const sid = await createSession(app);

    const resp = await app.fetch(
      new Request(`http://localhost/api/sessions/${sid}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "write it" }),
      }),
    );
    expect(resp.status).toBe(200);

    const stream = frameReader(resp);
    let permissionId: string | null = null;
    for (;;) {
      const ev = await stream.next();
      if (ev === null) break;
      if (ev.type === "permission_request") {
        permissionId = ev.id as string;
        break;
      }
    }
    expect(permissionId).not.toBeNull();

    const denyResp = await app.fetch(
      new Request(`http://localhost/api/permissions/${permissionId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answer: "deny" }),
      }),
    );
    expect(denyResp.status).toBe(200);

    const seen: SseEvent[] = [];
    for (;;) {
      const ev = await stream.next();
      if (ev === null) break;
      seen.push(ev);
    }

    const toolEnd = seen.find((e) => e.type === "tool_end");
    expect(String(toolEnd?.result)).toContain("User denied");

    expect(fs.existsSync(path.join(config.root, "denied.txt"))).toBe(false);
    const msgs = Session.load(sid).messages;
    const toolMsgs = msgs.filter((m) => m.role === "tool");
    expect(toolMsgs.some((m) => String(m.content).includes("User denied"))).toBe(true);
  });

  it("test_unknown_permission_id_returns_404", async () => {
    const app = createApp();
    const resp = await app.fetch(
      new Request("http://localhost/api/permissions/doesnotexist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answer: "once" }),
      }),
    );
    expect(resp.status).toBe(404);
    expect(await resp.json()).toEqual({ detail: "permission request not found (expired?)" });
  });
});
