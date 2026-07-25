// Regression test for the repl.ts wiring half of the "/quit doesn't actually
// exit" bug (see test/process-registry.test.ts for the underlying mechanism:
// a lingering exec_command PTY session keeps a real OS handle open, and
// process.on("exit", cleanup) can never fire to reap it because that handle
// is exactly what stops the event loop from ever going idle). This test
// proves runRepl() itself calls killAllToolProcesses() on its way out —
// previously it only did so on a mid-turn Ctrl+C cancel, never on a graceful
// "/quit"/Ctrl+D exit.

import { afterEach, describe, expect, it, vi } from "vitest";

const killHooks = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../src/tools/process-registry.js", () => ({
  killAllToolProcesses: () => {
    killHooks.calls += 1;
    return 0;
  },
}));

// Fakes a readline.Interface whose first question() answers "/quit" and
// whose close() fires the registered "close" listener (mirrors what a real
// Ctrl+D does), matching repl.ts's makePromptSession() usage of the module.
vi.mock("node:readline", () => {
  return {
    default: {
      createInterface: () => {
        const listeners: Record<string, (() => void)[]> = {};
        return {
          on(event: string, cb: () => void) {
            (listeners[event] ??= []).push(cb);
            return this;
          },
          question(_prompt: string, cb: (answer: string) => void) {
            cb("/quit");
          },
          close() {
            for (const cb of listeners["close"] ?? []) cb();
          },
        };
      },
    },
  };
});

vi.mock("../src/hooks/runner.js", () => ({ runSessionEndHooks: () => {} }));

import { Agent } from "../src/agent.js";
import { runRepl } from "../src/cli/repl.js";

afterEach(() => {
  killHooks.calls = 0;
  vi.restoreAllMocks();
});

describe("runRepl exit cleanup", () => {
  it("test_quit_kills_lingering_tool_processes_before_returning", async () => {
    await runRepl(new Agent());
    expect(killHooks.calls).toBeGreaterThan(0);
  });
});
