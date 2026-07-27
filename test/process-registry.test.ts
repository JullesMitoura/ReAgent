// Regression test for a bug found while investigating a user report: `/quit`
// (and Ctrl+D at the bare prompt) printed "See you!" and broke out of the
// REPL loop, but the WHOLE PROCESS never actually terminated — the terminal
// was left half-attached (no prompt, keystrokes just echoed back with no
// response) until killed externally.
//
// Root cause: a long-lived exec_command session (node-pty) — exactly what a
// dev-server preview started mid-conversation looks like — keeps a real OS
// process handle open. process.on("exit", cleanup) in exec-sessions.ts can
// never fire to reap it, because THAT handle is precisely what stops the
// event loop from ever going idle enough to reach "exit" in the first place.
// killAllToolProcesses() (process-registry.ts) was already wired into every
// *cancellation* path (Ctrl+C mid-turn, -p/exec SIGINT) but not into the
// REPL's graceful exit path, which only calls it on the way OUT — this test
// proves the aggregator actually reaches and terminates a real lingering
// exec_command session (the piece repl.ts's exit path was missing).

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { config } from "../src/config.js";
import * as execSessions from "../src/tools/exec-sessions.js";
import { killAllToolProcesses } from "../src/tools/process-registry.js";

const originalRoot = config.root;
let project: string;

// The lingering-session fixture below needs a long-lived child process and
// uses a literal `python3` command for that. Bare Windows installs (and some
// minimal POSIX images) only ship `python`/`py`, not a `python3` alias, so the
// test is gated on the interpreter's actual presence rather than on platform
// alone.
const hasPython3 = (() => {
  try {
    return spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
})();

beforeEach(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), "reagent-process-registry-"));
  config.setRoot(project);
  config.autoApprove = true;
  config.contextFile = false;
  config.enableExecSessions = true;
});

afterEach(() => {
  execSessions.cleanup(); // never leak a process between tests
  config.setRoot(originalRoot);
  fs.rmSync(project, { recursive: true, force: true });
});

describe("killAllToolProcesses", () => {
  it.skipIf(!hasPython3)("test_terminates_a_lingering_exec_command_session", async () => {
    // A long-lived command (like a dev server started to preview a generated
    // game) becomes a tracked session instead of blocking the tool call.
    const cmd =
      "python3 -c 'import time; time.sleep(0.8); print(\"up\", flush=True); time.sleep(30)'";
    const first = await execSessions.execCommand(cmd, 300);
    expect(first).toContain("started; process still running");
    expect(execSessions.listSessions()).toContain("running");

    killAllToolProcesses();

    // The registry is cleared synchronously (the kill signal itself lands
    // asynchronously on the OS side, but reagent must stop tracking — and
    // stop waiting on — the session immediately).
    expect(execSessions.listSessions()).toBe("no sessions");
  });
});
