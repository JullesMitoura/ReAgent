// 1:1 mirror of tests/test_shell.py (18 tests).
//
// Python's monkeypatch becomes vi.mock with passthrough to the real
// implementation, overridden per test: _allow() plays the role of confirm_bash ->
// True and _noSandbox() that of sandbox.available -> False.

import { spawn } from "node:child_process";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isDangerousCommand } from "../src/command-safety.js";
import { config, MAX_TOOL_OUTPUT } from "../src/config.js";
import { confirmBash } from "../src/permissions.js";
import { available } from "../src/sandbox.js";
import { _resetTasks, listTasks } from "../src/tools/background-tasks.js";
import {
  _ABORTED,
  _ACTIVE,
  _setMaxOutput,
  bash,
  killActive,
  MAX_OUTPUT,
} from "../src/tools/shell.js";
import { newTurnContext, runWithTurn } from "../src/turn-context.js";
import type { AskOutcome, PermissionKind } from "../src/types.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
vi.mock("../src/permissions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/permissions.js")>();
  return { ...actual, confirmBash: vi.fn(actual.confirmBash) };
});
vi.mock("../src/sandbox.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/sandbox.js")>();
  return { ...actual, available: vi.fn(actual.available) };
});
vi.mock("../src/command-safety.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/command-safety.js")>();
  return { ...actual, isDangerousCommand: vi.fn(actual.isDangerousCommand) };
});

const realCp = await vi.importActual<typeof import("node:child_process")>("node:child_process");
const realPermissions =
  await vi.importActual<typeof import("../src/permissions.js")>("../src/permissions.js");
const realSandbox = await vi.importActual<typeof import("../src/sandbox.js")>("../src/sandbox.js");
const realSafety =
  await vi.importActual<typeof import("../src/command-safety.js")>("../src/command-safety.js");

const spawnMock = vi.mocked(spawn);

function _allow(): void {
  vi.mocked(confirmBash).mockResolvedValue(true);
}

function _noSandbox(): void {
  vi.mocked(available).mockReturnValue(false);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Environment variables touched by the tests (Python's monkeypatch.setenv).
const ENV_KEYS = ["AZURE_OPENAI_KEY", "MY_API_TOKEN", "REAGENT_PLAIN_VALUE"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  // defaults: passthrough to the real implementations, call counts reset
  spawnMock.mockImplementation(realCp.spawn as never);
  spawnMock.mockClear();
  vi.mocked(confirmBash).mockImplementation(realPermissions.confirmBash);
  vi.mocked(available).mockImplementation(realSandbox.available);
  vi.mocked(isDangerousCommand).mockImplementation(realSafety.isDangerousCommand);
  _setMaxOutput(null);
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
});

afterEach(() => {
  _setMaxOutput(null);
  _resetTasks();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("shell", () => {
  it("test_echo_returns_output_and_exit_code", async () => {
    _allow();
    const result = await bash("echo hi");
    expect(result).toContain("hi");
    expect(result).toContain("Exit code: 0");
  });

  it("test_denied_command", async () => {
    // no sandbox available, the classic flow asks before executing
    _noSandbox();
    vi.mocked(confirmBash).mockResolvedValue(false);
    expect(await bash("echo hi")).toBe("User denied command execution.");
  });

  it("test_secret_env_var_is_scrubbed", async () => {
    _allow();
    process.env.AZURE_OPENAI_KEY = "super-secret-value";
    const result = await bash("echo $AZURE_OPENAI_KEY");
    expect(result).not.toContain("super-secret-value");
  });

  it("test_generic_secret_substring_is_scrubbed", async () => {
    _allow();
    process.env.MY_API_TOKEN = "leaked-token-123";
    const result = await bash("echo $MY_API_TOKEN");
    expect(result).not.toContain("leaked-token-123");
  });

  it("test_non_secret_env_var_survives", async () => {
    _allow();
    process.env.REAGENT_PLAIN_VALUE = "visible-42";
    const result = await bash("echo $REAGENT_PLAIN_VALUE");
    expect(result).toContain("visible-42");
  });

  it("test_timeout_preserves_partial_output", async () => {
    _allow();
    _noSandbox();
    const result = await bash("echo partial-marker; sleep 30", 1);
    expect(result).toContain("partial-marker");
    expect(result).toContain("timed out after 1s");
    expect(result).toContain("[exit code: 124]");
  });

  it("test_header_has_wall_time_and_output", async () => {
    _allow();
    _noSandbox();
    const result = await bash("echo cabecalho");
    expect(result).toContain("Exit code: 0");
    expect(result).toContain("Wall time: ");
    expect(result).toContain("Output:\ncabecalho");
  });

  it("test_exit_by_signal_maps_to_128_plus", async () => {
    _allow();
    _noSandbox();
    vi.mocked(isDangerousCommand).mockReturnValue(false);
    const result = await bash("kill -9 $$");
    expect(result).toContain("Exit code: 137 (SIGKILL)");
  });

  it("test_total_lines_reported_when_truncated", async () => {
    _allow();
    _noSandbox();
    _setMaxOutput(2_000);
    const cmd = "python3 -c 'print(\"\\n\".join(str(i) for i in range(5000)))'";
    const result = await bash(cmd);
    expect(result).toContain("Total output lines: 5000");
    expect(result).toContain("chars omitted");
  });

  it("test_invalid_utf8_output_does_not_crash", async () => {
    _allow();
    _noSandbox();
    const result = await bash("printf '\\xff\\xfe binario-ok'");
    expect(result).toContain("Exit code: 0");
    expect(result).toContain("binario-ok");
  });

  it("test_background_child_does_not_block_return", async () => {
    _allow();
    _noSandbox();
    const start = performance.now();
    const result = await bash("sleep 3 & echo done");
    const elapsed = (performance.now() - start) / 1000;
    expect(result).toContain("done");
    expect(result).toContain("Exit code: 0");
    expect(elapsed).toBeLessThan(2.5); // the background child does not hold the return
  });

  it("test_stderr_survives_giant_stdout", async () => {
    _allow();
    _noSandbox();
    _setMaxOutput(10_000);
    const cmd =
      "python3 -c 'import sys; sys.stdout.write(\"x\" * 50000); " +
      "sys.stderr.write(\"boom\")'";
    const result = await bash(cmd);
    expect(result).toContain("[stderr]");
    expect(result).toContain("boom");
  });

  it("test_stdin_is_devnull", async () => {
    _allow();
    _noSandbox();
    const start = performance.now();
    const result = await bash("cat"); // without DEVNULL it would hang waiting for stdin
    expect(result).toContain("Exit code: 0");
    expect((performance.now() - start) / 1000).toBeLessThan(5);
  });

  it("test_blank_command_errors_without_spawn", async () => {
    _allow();
    spawnMock.mockImplementation((() => {
      throw new Error("spawn should not be called for an empty command");
    }) as never);
    expect(await bash("   ")).toBe("Error: empty command");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("test_commands_run_under_explicit_bash", async () => {
    _allow();
    _noSandbox();
    const result = await bash("echo via-bash");
    expect(result).toContain("via-bash");
    const call = spawnMock.mock.calls[0] as unknown as [string, string[], object];
    const [file, args] = call;
    expect(Array.isArray(args)).toBe(true);
    expect(["bash", "sh"]).toContain(path.basename(file));
    expect(file.endsWith("bash")).toBe(true); // /bin/bash existe em macOS/Linux de CI
  });

  it("test_kill_active_aborts_running_command", async () => {
    _allow();
    _noSandbox();
    const pending = bash("echo start; sleep 30", 60);
    const deadline = performance.now() + 5000;
    let active = false;
    while (performance.now() < deadline) {
      active = _ACTIVE.size > 0;
      if (active) break;
      await sleep(20);
    }
    expect(active, "process not registered in _ACTIVE").toBe(true);
    await sleep(200); // give the echo a moment to come out before the kill
    expect(killActive()).toBe(1);
    const result = await pending;
    expect(result).toContain("(command aborted by user)");
    expect(result).toContain("start");
    expect(_ACTIVE.size).toBe(0);
    expect(_ABORTED.size).toBe(0);
  });

  it("test_kill_active_noop_when_idle", () => {
    expect(killActive()).toBe(0);
  });

  it("test_output_is_bounded", () => {
    // deliberately high cap: it bounds transient memory; what goes to the model
    // is cut by dispatch (MAX_TOOL_OUTPUT) with a spill to .reagent/truncations
    expect(MAX_OUTPUT).toBe(2_000_000);
    expect(MAX_OUTPUT).toBeGreaterThan(MAX_TOOL_OUTPUT); // the spill has something to save
  });

  it("test_description_forwarded_to_permission_gate", async () => {
    _noSandbox();
    vi.mocked(confirmBash).mockResolvedValue(true);
    await bash("sleep 0", 5, { description: "sleep for zero seconds" });
    expect(confirmBash).toHaveBeenCalledWith("sleep 0", "sleep for zero seconds");
  });

  it("test_description_shown_as_permission_preview", async () => {
    _noSandbox();
    const savedAutoApprove = config.autoApprove;
    config.autoApprove = false;
    let captured: { action: string; preview: string | null } | null = null;
    const handler = (
      _kind: PermissionKind,
      action: string,
      preview: string | null,
    ): Promise<AskOutcome> => {
      captured = { action, preview };
      return Promise.resolve("once" as AskOutcome);
    };
    try {
      const result = await runWithTurn(newTurnContext({ permissionHandler: handler }), () =>
        bash("sleep 0", 5, { description: "sleep for zero seconds" }),
      );
      expect(result).toContain("Exit code: 0");
      expect(captured).not.toBeNull();
      expect(captured!.action).toContain("execute command: sleep 0");
      expect(captured!.preview).toBe("sleep for zero seconds");
    } finally {
      config.autoApprove = savedAutoApprove;
    }
  });

  it("test_run_in_background_returns_ack_immediately", async () => {
    _allow();
    const start = performance.now();
    const result = await bash("sleep 30", 120, { runInBackground: true });
    expect((performance.now() - start) / 1000).toBeLessThan(2);
    expect(result).toContain("Started background task");
    expect(result).toContain("task_output");
    // this test runs at the real repo root: drop the log it created
    const logs = listTasks().map((t) => t.logPath);
    _resetTasks();
    const fs = await import("node:fs");
    for (const log of logs) fs.rmSync(log, { force: true });
  });

  it("test_invalid_timeout_type_returns_controlled_error", async () => {
    // regression: Math.min("abc", 600) === NaN, and setTimeout(fn, NaN) fires
    // almost immediately, so this used to return a bogus "Command timed out
    // after NaNs" instead of a controlled error
    _allow();
    spawnMock.mockImplementation((() => {
      throw new Error("spawn should not be called for an invalid timeout");
    }) as never);
    const result = await bash("sleep 3 && echo done", "abc" as unknown as number);
    expect(result).toContain("Error:");
    expect(result).toContain("timeout");
    expect(result).not.toContain("NaN");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("test_run_in_background_denied_never_spawns", async () => {
    vi.mocked(confirmBash).mockResolvedValue(false);
    spawnMock.mockImplementation((() => {
      throw new Error("spawn should not be called when permission is denied");
    }) as never);
    expect(await bash("sleep 5", 120, { runInBackground: true })).toBe(
      "User denied command execution.",
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
