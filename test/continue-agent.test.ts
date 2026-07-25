import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { config } from "../src/config.js";

vi.mock("../src/llm/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/llm/client.js")>();
  return { ...actual, chat: vi.fn(actual.chat) };
});

import { chat } from "../src/llm/client.js";
import { clearAgentSessions, getAgentSession } from "../src/agents/sessions.js";
import { continueAgent, runAgent } from "../src/agents/run.js";
import { sendMessage } from "../src/tools/send-message.js";
import { activeSchemas } from "../src/tools/index.js";
import "../src/agents/index.js";
import "../src/tools/send-message.js";

interface FakeMessage {
  content?: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] | null;
}
function textResp(text: string): { choices: { message: FakeMessage }[] } {
  return { choices: [{ message: { content: text, tool_calls: null } }] };
}

function script(responses: unknown[]): void {
  let i = 0;
  vi.mocked(chat).mockImplementation(async () => {
    const r = responses[i];
    i += 1;
    return r as never;
  });
}

const originalRoot = config.root;
const originalEnableSubagent = config.enableSubagent;
const originalCoordinator = config.coordinatorMode;
let project: string;

beforeEach(() => {
  project = config.setRoot(fs.mkdtempSync(path.join(os.tmpdir(), "reagent-continue-")));
  config.autoApprove = true;
  config.contextFile = false;
  config.enableSubagent = true;
  config.coordinatorMode = false;
  clearAgentSessions();
});

afterEach(() => {
  vi.mocked(chat).mockReset();
  config.enableSubagent = originalEnableSubagent;
  config.coordinatorMode = originalCoordinator;
  config.setRoot(originalRoot);
  clearAgentSessions();
  fs.rmSync(project, { recursive: true, force: true });
});

describe("send_message / continue agent", () => {
  it("registers agent-id and continues with full transcript", async () => {
    script([textResp("first report: found auth.ts"), textResp("second report: fixed null check")]);
    const first = await runAgent({
      agentType: "explore",
      prompt: "Find auth handling",
      title: "auth search",
    });
    expect(first).toContain("first report");
    expect(first).toMatch(/agent-id: agent-/);
    const idMatch = first.match(/agent-id: (agent-\S+)/);
    expect(idMatch).toBeTruthy();
    const id = idMatch![1]!;
    expect(getAgentSession(id)?.status).toBe("completed");

    const second = await continueAgent(id, "Now focus on validate.ts:42");
    expect(second).toContain("second report");
    expect(second).toContain(id);
    expect(vi.mocked(chat).mock.calls.length).toBe(2);
    const secondMsgs = vi.mocked(chat).mock.calls[1]![0] as { role: string; content: string }[];
    expect(secondMsgs.some((m) => m.role === "user" && String(m.content).includes("validate.ts:42"))).toBe(
      true,
    );
  });

  it("send_message tool wraps continueAgent", async () => {
    script([textResp("ok"), textResp("continued")]);
    const first = await runAgent({ agentType: "explore", prompt: "x", title: "t" });
    const id = first.match(/agent-id: (agent-\S+)/)![1]!;
    const out = await sendMessage(id, "follow up", "fix");
    expect(out).toContain("continued");
    const contMsgs = vi.mocked(chat).mock.calls[1]![0] as { role: string; content: string }[];
    expect(
      contMsgs.some(
        (m) => m.role === "user" && String(m.content).includes("[Continue: fix]") && String(m.content).includes("follow up"),
      ),
    ).toBe(true);
  });

  it("coordinator mode withholds write tools from lead schemas", () => {
    config.coordinatorMode = true;
    const names = new Set(
      activeSchemas().map((s) => (s as { function: { name: string } }).function.name),
    );
    expect(names.has("agent")).toBe(true);
    expect(names.has("send_message")).toBe(true);
    expect(names.has("write_file")).toBe(false);
    expect(names.has("bash")).toBe(false);
    config.coordinatorMode = false;
  });
});
