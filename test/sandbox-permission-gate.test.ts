// Non-safe commands must prompt even when Seatbelt is available (critical
// security fix: sandbox-first previously skipped confirmBash while the
// profile still allowed reading the whole host disk).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isDangerousCommand, isSafeCommand } from "../src/command-safety.js";
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
  return {
    ...actual,
    isDangerousCommand: vi.fn(actual.isDangerousCommand),
    isSafeCommand: vi.fn(actual.isSafeCommand),
  };
});

const originalRoot = config.root;
let project: string;

beforeEach(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), "reagent-sbxgate-"));
  config.setRoot(project);
  config.autoApprove = false;
  config.contextFile = false;
  vi.mocked(isDangerousCommand).mockReturnValue(false);
  vi.mocked(isSafeCommand).mockReturnValue(false);
  vi.mocked(available).mockReturnValue(true);
  vi.mocked(wrap).mockImplementation((c: string) => ["/bin/bash", "-lc", c]);
  vi.mocked(confirmBash).mockReset();
  vi.mocked(confirmBash).mockResolvedValue(true);
});

afterEach(() => {
  config.setRoot(originalRoot);
  fs.rmSync(project, { recursive: true, force: true });
});

describe("sandbox permission gate for non-safe commands", () => {
  it("calls confirmBash before sandboxed execution of non-safe commands", async () => {
    vi.mocked(confirmBash).mockResolvedValue(true);
    const result = await bash("cp /etc/passwd stolen.txt");
    expect(confirmBash).toHaveBeenCalled();
    expect(result).toContain("Exit code:");
  });

  it("denies without running when confirmBash returns false", async () => {
    vi.mocked(confirmBash).mockResolvedValue(false);
    vi.mocked(wrap).mockImplementation(() => {
      throw new Error("wrap must not run when permission denied");
    });
    expect(await bash("cp /etc/passwd stolen.txt")).toBe("User denied command execution.");
  });

  it("still skips confirmBash for safe commands inside the sandbox", async () => {
    vi.mocked(isSafeCommand).mockReturnValue(true);
    vi.mocked(confirmBash).mockImplementation(() => {
      throw new Error("confirmBash must not be called for safe sandboxed commands");
    });
    const result = await bash("echo ok-safe");
    expect(result).toContain("ok-safe");
  });

  it("retries unsandboxed after sandbox denial without a second prompt for non-safe", async () => {
    vi.mocked(confirmBash).mockResolvedValue(true);
    vi.mocked(wrap).mockImplementation(() => [
      "/bin/bash",
      "-lc",
      "echo 'Operation not permitted' >&2; exit 1",
    ]);
    const result = await bash("npm test");
    expect(result.startsWith("[ran unsandboxed after approval]\n")).toBe(true);
    expect(result).toContain("Exit code:");
    // One upfront approval only — no re-prompt on sandbox escape for non-safe.
    expect(confirmBash).toHaveBeenCalledTimes(1);
  });
});
