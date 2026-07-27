// 1:1 mirror of tests/test_exec_sessions.py: exec_command and write_stdin
// over PTY (node-pty). Deliberate differences from Python:
// - the monkeypatch of permissions.confirm_bash (test_denied_permission) becomes a
//   TurnContext with a permissionHandler that denies (ESM does not allow monkeypatching
//   a namespace); the command used cannot be on the safe list (echo is safe and does
//   not ask), so it uses "touch denied.txt";
// - BUFFER_CAP is an export const (contract): test_session_buffer_cap uses a
//   real output larger than the 1MB cap instead of shrinking the cap.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { config } from "../src/config.js";
import { capHeadTail, HeadTailBuffer } from "../src/lib/head-tail-buffer.js";
import * as execSessions from "../src/tools/exec-sessions.js";
import { newTurnContext, runWithTurn } from "../src/turn-context.js";

const originalRoot = config.root;
let project: string;

// A few tests need a long-lived/large-output child process and use a literal
// `python3` command for that. Bare Windows installs (and some minimal POSIX
// images) only ship `python`/`py`, not a `python3` alias, so those tests are
// gated on the interpreter's actual presence rather than on platform alone.
const hasPython3 = (() => {
  try {
    return spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
})();

function sessionId(text: string): number {
  const m = /\[session (\d+) started/.exec(text);
  expect(m, `session id not found in: ${JSON.stringify(text)}`).not.toBeNull();
  return Number(m![1]);
}

beforeEach(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), "reagent-exec-"));
  config.setRoot(project);
  // automatic approval in tests; everything restored in afterEach via setRoot
  config.autoApprove = true;
  config.contextFile = false;
  config.enableExecSessions = true;
});

afterEach(() => {
  execSessions.cleanup(); // never leak processes between tests
  config.setRoot(originalRoot);
  fs.rmSync(project, { recursive: true, force: true });
});

describe("exec sessions", () => {
  it("test_fast_command_returns_exit_code_without_session", async () => {
    const result = await execSessions.execCommand("echo fast", 5000);
    expect(result).toContain("fast");
    expect(result).toContain("Exit code: 0");
    expect(result).toContain("Wall time: ");
    expect(result).not.toContain("[session");
    expect(execSessions.listSessions()).toBe("no sessions");
  });

  it.skipIf(!hasPython3)("test_long_command_becomes_session_and_poll_gets_output", async () => {
    const cmd =
      "python3 -c 'import time; time.sleep(0.8); print(\"up\", flush=True); time.sleep(30)'";
    const first = await execSessions.execCommand(cmd, 300);
    expect(first).toContain("started; process still running");
    const sid = sessionId(first);
    expect(execSessions.listSessions()).toContain("running");
    const polled = await execSessions.execCommand("", 3000, sid);
    expect(polled).toContain("up");
  });

  it("test_write_stdin_echoes_and_increment_is_consumed", async () => {
    const first = await execSessions.execCommand("cat", 300);
    const sid = sessionId(first);
    const out = await execSessions.writeStdin(sid, "hello\n", 1000);
    expect(out).toContain("hello");
    // empty chars = poll only; the previous increment was already consumed
    const again = await execSessions.writeStdin(sid, "", 300);
    expect(again).not.toContain("hello");
    // ctrl-d ends cat: the session terminates and leaves the store
    const closed = await execSessions.writeStdin(sid, "\x04", 3000);
    expect(closed).toContain(`session ${sid} terminated with exit code 0`);
    expect(closed).toContain("wall time");
    expect(execSessions.listSessions()).toBe("no sessions");
  });

  it.skipIf(!hasPython3)("test_dead_session_is_detected_and_removed", async () => {
    const first = await execSessions.execCommand(
      "python3 -c 'import time; time.sleep(0.6)'",
      300,
    );
    const sid = sessionId(first);
    const polled = await execSessions.execCommand("", 5000, sid);
    expect(polled).toContain(`session ${sid} terminated with exit code 0`);
    // removed from the store: interacting again gives a clear error with the live sessions
    const after = await execSessions.writeStdin(sid, "x", 300);
    expect(after).toContain("Error");
    expect(after).toContain("Live sessions: none");
  });

  it("test_head_tail_buffer_cap", () => {
    const buf = new HeadTailBuffer(100);
    buf.append("a".repeat(80));
    buf.append("b".repeat(80));
    buf.append("c".repeat(80));
    const out = buf.take();
    expect(out).toContain("[140 chars omitted]");
    expect(out.startsWith("a".repeat(50))).toBe(true);
    expect(out.endsWith("c".repeat(50))).toBe(true);
    expect(buf.take()).toBe(""); // cursor: increment already delivered
  });

  it.skipIf(!hasPython3)("test_session_buffer_cap_applies_to_real_output", async () => {
    // real output larger than BUFFER_CAP (1MB): the session buffer cuts the middle
    const result = await execSessions.execCommand(
      "python3 -c 'print(\"x\" * 2500000)'",
      20000,
    );
    expect(result).toContain("chars omitted]");
    expect(result).toContain("Exit code: 0");
  });

  it("test_poll_increment_cap", () => {
    const text = "h".repeat(20000) + "t".repeat(20000);
    const capped = capHeadTail(text, 30000);
    expect(capped).toContain("[10000 chars omitted]");
    expect(capped.length).toBeLessThan(31000);
  });

  it("test_session_limit", async () => {
    config.execSessionMax = 1;
    const first = await execSessions.execCommand("cat", 300);
    sessionId(first);
    const second = await execSessions.execCommand("cat", 300);
    expect(second).toContain("too many live exec sessions");
    expect(second).toContain("(1/1)");
  });

  it("test_disabled_gate", async () => {
    config.enableExecSessions = false;
    const msg = "Error: exec sessions are disabled on this platform/config";
    expect(await execSessions.execCommand("echo hi")).toBe(msg);
    expect(await execSessions.writeStdin(1, "x")).toBe(msg);
  });

  it("test_denied_permission", async () => {
    config.autoApprove = false;
    const ctx = newTurnContext({ permissionHandler: async () => "deny" as const });
    const result = await runWithTurn(ctx, () =>
      execSessions.execCommand("touch denied.txt"),
    );
    expect(result).toBe("User denied command execution.");
  });

  it("test_missing_command_without_session_id_returns_controlled_error", async () => {
    // regression: exec_command with neither command nor session_id used to
    // crash with a raw "Unexpected error: TypeError: Cannot read properties
    // of undefined (reading 'trim')" from confirmBash's command.trim()
    const result = await execSessions.execCommand(undefined as unknown as string);
    expect(result.startsWith("Error:")).toBe(true);
    expect(result).toContain("command");
    expect(result).not.toContain("TypeError");
  });

  it("test_schemas_exported", () => {
    expect(execSessions.EXEC_COMMAND_SCHEMA.function.name).toBe("exec_command");
    expect(execSessions.WRITE_STDIN_SCHEMA.function.name).toBe("write_stdin");
  });
});
