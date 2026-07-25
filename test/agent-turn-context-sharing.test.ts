// Regression test for a bug found during the second-round audit: nested
// TurnContexts created by agents/run.ts's `{...parentTurn, ...overrides}`
// (needed so each sub-agent gets its own changes/toolRoot/bgNotify*) are
// DISTINCT objects, which broke permissions.ts's WeakMap-keyed per-turn
// ask-lock (askChainByTurn) — despite its own comment claiming sibling
// sub-agents "share the parent's TurnContext". Two sibling sub-agents
// spawned from the same parent turn (e.g. via parallel_agents) could fire
// concurrent permission prompts instead of serializing them, which in TTY
// mode meant two `readline.createInterface(process.stdin)` instances racing
// on the same stdin. The fix threads a shared `askLockRoot` object reference
// through every clone (object spread copies the reference, not a deep copy),
// and permissions.ts now keys its lock on that instead of the TurnContext
// object itself.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/llm/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/llm/client.js")>();
  return { ...actual, chat: vi.fn(actual.chat) };
});

import { chat } from "../src/llm/client.js";
import { config } from "../src/config.js";
import { runAgent } from "../src/agents/run.js";
import { newTurnContext, runWithTurn } from "../src/turn-context.js";
import type { PermissionHandler } from "../src/turn-context.js";

interface FakeMessage {
  content?: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] | null;
}
function toolResp(cid: string, name: string, args: string): { choices: { message: FakeMessage }[] } {
  return {
    choices: [
      { message: { content: null, tool_calls: [{ id: cid, type: "function", function: { name, arguments: args } }] } },
    ],
  };
}
function textResp(text: string): { choices: { message: FakeMessage }[] } {
  return { choices: [{ message: { content: text, tool_calls: null } }] };
}

const originalRoot = config.root;
const originalSandboxMode = config.sandboxMode;
let project: string;

beforeEach(() => {
  project = config.setRoot(fs.mkdtempSync(path.join(os.tmpdir(), "reagent-turnctx-")));
  config.autoApprove = false;
  config.contextFile = false;
  // Force the unsandboxed confirmBash path: macOS Seatbelt runs non-dangerous
  // commands straight through (see tools/shell.ts's `available()` branch) and
  // only asks if the sandbox itself denies something, which this test isn't
  // exercising — it needs every bash call to reach confirmBash unconditionally.
  config.sandboxMode = "off";
});

afterEach(() => {
  vi.mocked(chat).mockReset();
  config.sandboxMode = originalSandboxMode;
  config.setRoot(originalRoot);
  fs.rmSync(project, { recursive: true, force: true });
});

describe("nested TurnContext ask-lock sharing", () => {
  it("sibling sub-agents spawned from the same parent turn serialize permission prompts", async () => {
    // Each worker: one bash call needing approval (a command with no shell
    // operators, not in the read-only safelist, so it must reach the
    // handler), then a final text answer.
    let call = 0;
    vi.mocked(chat).mockImplementation(async () => {
      call += 1;
      if (call === 1) return toolResp("w1-c0", "bash", '{"command": "reagent-test-cmd-a"}') as never;
      if (call === 2) return toolResp("w2-c0", "bash", '{"command": "reagent-test-cmd-b"}') as never;
      return textResp("done") as never;
    });

    let concurrent = 0;
    let maxConcurrent = 0;
    const handler: PermissionHandler = async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 20));
      concurrent -= 1;
      return "once";
    };

    const parentCtx = newTurnContext({ permissionHandler: handler });
    await runWithTurn(parentCtx, () =>
      Promise.all([
        runAgent({ agentType: "worker", prompt: "task A", title: "worker-a", sessionFooter: false }),
        runAgent({ agentType: "worker", prompt: "task B", title: "worker-b", sessionFooter: false }),
      ]),
    );

    // Without the fix, both nested contexts get their own empty ask-lock
    // chain and the handler runs twice concurrently (maxConcurrent === 2).
    expect(maxConcurrent).toBe(1);
    expect(call).toBeGreaterThanOrEqual(4); // both agents actually ran to completion
  });
});
