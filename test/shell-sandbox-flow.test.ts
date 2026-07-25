// 1:1 mirror of the 6 bash flow tests of tests/test_sandbox.py
// (test_bash_*). The profile/wrap/available/denial themselves belong to the
// owner of sandbox.ts and are in sandbox.test.ts.
//
// Port note: in Python the monkeypatch of shell.is_dangerous_command did not
// affect permissions.confirm_bash (per-module bindings); here the
// vi.mock of command-safety.js is shared, so confirm_bash is also
// mocked in the tests that Python resolved via AUTO_APPROVE.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isDangerousCommand } from "../src/command-safety.js";
import { config } from "../src/config.js";
import { confirmBash } from "../src/permissions.js";
import { available, wrap } from "../src/sandbox.js";
import { bash } from "../src/tools/shell.js";

vi.mock("../src/permissions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/permissions.js")>();
  return { ...actual, confirmBash: vi.fn(actual.confirmBash) };
});
vi.mock("../src/sandbox.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/sandbox.js")>();
  return { ...actual, available: vi.fn(actual.available), wrap: vi.fn(actual.wrap) };
});
vi.mock("../src/command-safety.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/command-safety.js")>();
  return { ...actual, isDangerousCommand: vi.fn(actual.isDangerousCommand) };
});

const realPermissions =
  await vi.importActual<typeof import("../src/permissions.js")>("../src/permissions.js");
const realSandbox = await vi.importActual<typeof import("../src/sandbox.js")>("../src/sandbox.js");
const realSafety =
  await vi.importActual<typeof import("../src/command-safety.js")>("../src/command-safety.js");

function nuncaPergunta(): never {
  throw new Error("confirm_bash should not be called on the sandbox path");
}

const originalRoot = config.root;
let project: string;

// conftest "project" fixture: tmp root + autoApprove + contextFile off.
beforeEach(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), "reagent-shellflow-"));
  config.setRoot(project);
  config.autoApprove = true;
  config.contextFile = false;
  vi.mocked(confirmBash).mockImplementation(realPermissions.confirmBash);
  vi.mocked(available).mockImplementation(realSandbox.available);
  vi.mocked(wrap).mockImplementation(realSandbox.wrap);
  vi.mocked(isDangerousCommand).mockImplementation(realSafety.isDangerousCommand);
});

afterEach(() => {
  config.setRoot(originalRoot);
  fs.rmSync(project, { recursive: true, force: true });
});

describe("sandbox: fluxo do bash()", () => {
  it("test_bash_perigoso_usa_confirmacao_e_roda_sem_sandbox", async () => {
    // AUTO_APPROVE=true (project fixture): the confirmation approves without a prompt.
    vi.mocked(isDangerousCommand).mockReturnValue(true);
    vi.mocked(available).mockReturnValue(true);
    vi.mocked(wrap).mockImplementation(() => {
      throw new Error("a dangerous command never enters the sandbox");
    });
    vi.mocked(confirmBash).mockResolvedValue(true);
    const result = await bash("echo perigoso-ok");
    expect(result).toContain("perigoso-ok");
    expect(result).toContain("Exit code: 0");
  });

  it("test_bash_perigoso_negado", async () => {
    vi.mocked(isDangerousCommand).mockReturnValue(true);
    vi.mocked(confirmBash).mockResolvedValue(false);
    expect(await bash("echo hi")).toBe("User denied command execution.");
  });

  it("test_bash_sandbox_roda_sem_pedir_permissao", async () => {
    vi.mocked(isDangerousCommand).mockReturnValue(false);
    vi.mocked(available).mockReturnValue(true);
    // Fake sandbox: same command, no Seatbelt (the flow is what matters).
    vi.mocked(wrap).mockImplementation((c: string) => ["/bin/bash", "-lc", c]);
    vi.mocked(confirmBash).mockImplementation(nuncaPergunta);
    const result = await bash("echo contido");
    expect(result).toContain("contido");
    expect(result).toContain("Exit code: 0");
  });

  it("test_bash_negacao_do_sandbox_aprovada_reexecuta_fora", async () => {
    vi.mocked(isDangerousCommand).mockReturnValue(false);
    vi.mocked(available).mockReturnValue(true);
    // Simulates Seatbelt denying: stderr with the typical mark and exit 1.
    vi.mocked(wrap).mockImplementation(() => [
      "/bin/bash",
      "-lc",
      "echo 'Operation not permitted' >&2; exit 1",
    ]);
    vi.mocked(confirmBash).mockResolvedValue(true);
    const result = await bash("echo fora-do-sandbox");
    expect(result.startsWith("[ran unsandboxed after approval]\n")).toBe(true);
    expect(result).toContain("fora-do-sandbox");
    expect(result).toContain("Exit code: 0");
  });

  it("test_bash_negacao_do_sandbox_recusada_devolve_saida_do_sandbox", async () => {
    vi.mocked(isDangerousCommand).mockReturnValue(false);
    vi.mocked(available).mockReturnValue(true);
    vi.mocked(wrap).mockImplementation(() => [
      "/bin/bash",
      "-lc",
      "echo 'Operation not permitted' >&2; exit 1",
    ]);
    vi.mocked(confirmBash).mockResolvedValue(false);
    const result = await bash("echo qualquer");
    expect(result.startsWith("[blocked by sandbox; user denied unsandboxed run]\n")).toBe(true);
    expect(result).toContain("Operation not permitted");
    expect(result).toContain("Exit code: 1");
  });

  it("test_bash_sem_sandbox_usa_fluxo_classico", async () => {
    vi.mocked(isDangerousCommand).mockReturnValue(false);
    vi.mocked(available).mockReturnValue(false);
    vi.mocked(confirmBash).mockResolvedValue(false);
    expect(await bash("echo hi")).toBe("User denied command execution.");
    vi.mocked(confirmBash).mockResolvedValue(true);
    const result = await bash("echo classico");
    expect(result).toContain("classico");
    expect(result).toContain("Exit code: 0");
  });
});
