import { describe, expect, it } from "vitest";

import { formatPreviewForTerminal } from "../src/lib/terminal-diff.js";

describe("formatPreviewForTerminal", () => {
  it("colors unified diff lines when color is enabled", () => {
    const preview = ["--- a.ts", "+++ a.ts", "@@ -1 +1 @@", "-old", "+new", " ctx"].join("\n");
    const out = formatPreviewForTerminal(preview, true);
    expect(out).toContain("\x1b[32m+new\x1b[0m");
    expect(out).toContain("\x1b[31m-old\x1b[0m");
    expect(out).toContain("\x1b[36m@@ -1 +1 @@\x1b[0m");
  });

  it("returns plain text when color is disabled", () => {
    const preview = "--- a.ts\n+++ a.ts\n+added";
    expect(formatPreviewForTerminal(preview, false)).toBe(preview);
  });

  it("dims non-diff previews", () => {
    const out = formatPreviewForTerminal("plain description of the command", true);
    expect(out).toContain("\x1b[2m");
    expect(out).toContain("plain description");
  });
});
