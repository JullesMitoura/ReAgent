// 1:1 mirror of tests/test_abort.py: server turn interruption flow
// (TurnCancelled) and permission waiting.
//
// Since Python monkeypatches llm.chat and agent_module.dispatch, here we use
// vi.mock with swappable vi.hoisted holders per test. Python's TestClient
// becomes app.fetch in-process; the SSE response is read whole with res.text().

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// build_system_prompt -> "sys": hermetic builder (without reading the real USER.md).
vi.mock("../src/system-prompt.js", () => ({ buildSystemPrompt: () => "sys" }));

// Swappable holders (vi.hoisted runs before imports; avoids TDZ in the factories).
const hooks = vi.hoisted(() => ({
  chatImpl: null as null | (() => unknown),
  dispatchImpl: null as null | ((name: string, args: string) => string | Promise<string>),
}));

vi.mock("../src/llm/client.js", () => ({
  chat: () => (hooks.chatImpl ? hooks.chatImpl() : []),
  getClient: () => {
    throw new Error("no llm client in tests");
  },
}));

vi.mock("../src/tools/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/tools/index.js")>();
  return {
    ...actual,
    dispatch: (name: string, args: string) =>
      hooks.dispatchImpl ? hooks.dispatchImpl(name, args) : actual.dispatch(name, args),
  };
});

import { config } from "../src/config.js";
import { Session } from "../src/session.js";
import { ABORT_MARKER, _running, createApp } from "../src/server/app.js";
import * as shell from "../src/tools/shell.js";
import { currentTurn } from "../src/turn-context.js";

const originalRoot = config.root;
let project: string;

beforeEach(() => {
  project = config.setRoot(fs.mkdtempSync(path.join(os.tmpdir(), "reagent-abort-")));
  config.autoApprove = true;
  config.contextFile = false;
  hooks.chatImpl = null;
  hooks.dispatchImpl = null;
});

afterEach(() => {
  config.setRoot(originalRoot);
  fs.rmSync(project, { recursive: true, force: true });
});

interface SseEvent {
  type: string;
  [key: string]: unknown;
}

function parseEvents(text: string): SseEvent[] {
  return text
    .split("\n\n")
    .filter((f) => f.length > 0)
    .map((f) => {
      if (!f.startsWith("data: ")) throw new Error(`invalid frame: ${f}`);
      return JSON.parse(f.slice(6)) as SseEvent;
    });
}

// Fake stream with one tool call (list_dir) and usage at the end.
function toolCallStream(): unknown[] {
  const tc = { index: 0, id: "c0", function: { name: "list_dir", arguments: "{}" } };
  return [
    { choices: [{ delta: { content: null, tool_calls: [tc] }, finish_reason: null }], usage: null },
    {
      choices: [{ delta: { content: null, tool_calls: null }, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    },
  ];
}

// Fake stream requesting write_file (triggers permission with autoApprove off).
function writeCallStream(): unknown[] {
  const args = JSON.stringify({ path: "x.txt", content: "hi" });
  const tc = { index: 0, id: "c1", function: { name: "write_file", arguments: args } };
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

describe("abort", () => {
  it("test_turn_abort_repairs_history", async () => {
    hooks.chatImpl = () => toolCallStream();
    // the user hits stop while the tool runs: sets the turn's cancel
    hooks.dispatchImpl = () => {
      currentTurn()!.cancel.set = true;
      return "ok";
    };

    const app = createApp();
    const created = (await (
      await app.fetch(new Request("http://localhost/api/sessions", { method: "POST" }))
    ).json()) as { id: string };
    const sid = created.id;

    const resp = await app.fetch(
      new Request(`http://localhost/api/sessions/${sid}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "do it" }),
      }),
    );
    expect(resp.status).toBe(200);
    const events = parseEvents(await resp.text());
    const done = events.filter((e) => e.type === "done");
    expect(done.length).toBeGreaterThan(0);
    expect(done[done.length - 1]!.aborted).toBe(true);
    expect(String(done[done.length - 1]!.content)).toContain("interrupted");

    // reloaded session: assistant preserved, abort stub and user marker
    const msgs = Session.load(sid).messages;
    expect(msgs[msgs.length - 1]).toEqual({ role: "user", content: ABORT_MARKER });
    expect(msgs[msgs.length - 2]).toEqual({
      role: "tool",
      tool_call_id: "c0",
      content: "aborted by user",
    });
    expect(msgs[msgs.length - 3]!.role).toBe("assistant");
    expect(msgs[msgs.length - 3]!.tool_calls).toBeTruthy();
  });

  it("test_stop_turn_kills_active_bash", async () => {
    // stopping a live turn sets the cancel AND kills the running bash
    const spy = vi.spyOn(shell, "killActive").mockReturnValue(1);
    const cancel = { set: false };
    _running.set("stop-sid", { cancel, steer: [] });
    const app = createApp();
    try {
      const resp = await app.fetch(
        new Request("http://localhost/api/sessions/stop-sid/stop", { method: "POST" }),
      );
      expect(resp.status).toBe(200);
      expect(cancel.set).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      _running.delete("stop-sid");
      spy.mockRestore();
    }
  });

  it("test_permission_timeout_denies_with_neutral_message", async () => {
    // nobody answers the request: the tool receives the timeout message
    // ("ask again later"), not a deliberate "User denied".
    config.autoApprove = false;
    config.permissionTimeout = 0.3;

    let calls = 0;
    hooks.chatImpl = () => {
      calls += 1;
      return calls === 1 ? writeCallStream() : finalStream("finished");
    };

    const app = createApp();
    const created = (await (
      await app.fetch(new Request("http://localhost/api/sessions", { method: "POST" }))
    ).json()) as { id: string };
    const sid = created.id;

    const resp = await app.fetch(
      new Request(`http://localhost/api/sessions/${sid}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "write it" }),
      }),
    );
    expect(resp.status).toBe(200);
    const events = parseEvents(await resp.text());
    expect(events.some((e) => e.type === "permission_request")).toBe(true);

    const msgs = Session.load(sid).messages;
    const toolMsgs = msgs.filter((m) => m.role === "tool");
    expect(toolMsgs.some((m) => String(m.content).includes("ask again later"))).toBe(true);
    expect(toolMsgs.some((m) => String(m.content).includes("User denied"))).toBe(false);
    expect(fs.existsSync(path.join(config.root, "x.txt"))).toBe(false);
  });
});
