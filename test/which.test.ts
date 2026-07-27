import { describe, expect, it } from "vitest";
import path from "node:path";

import { which } from "../src/lib/which.js";

describe("which", () => {
  it("returns null for a program that does not exist", () => {
    expect(which("thisDoesNotExist12345xyz")).toBeNull();
  });

  it.skipIf(process.platform === "win32")("resolves ls on POSIX", () => {
    const found = which("ls");
    expect(found).not.toBeNull();
    expect(path.basename(found as string)).toBe("ls");
  });
});
