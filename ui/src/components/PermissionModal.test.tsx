import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { PermissionModal } from "./PermissionModal";
import type { PermissionRequest } from "../types";

const sampleRequest: PermissionRequest = {
  kind: "edit",
  action: "edit src/index.ts",
  preview: "--- src/index.ts\n+++ src/index.ts\n@@ -1,2 +1,2 @@\n-old line\n+new line",
  suggestion: "src/**",
};

afterEach(() => cleanup());

describe("PermissionModal accessibility", () => {
  it("exposes dialog semantics on the container", () => {
    const onAnswer = vi.fn();
    const { getByRole } = render(
      <PermissionModal request={sampleRequest} onAnswer={onAnswer} />,
    );
    const dialog = getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-labelledby")).toBe("permission-modal-title");
  });

  it("answers deny when Escape is pressed", () => {
    const onAnswer = vi.fn();
    const { getByRole } = render(
      <PermissionModal request={sampleRequest} onAnswer={onAnswer} />,
    );
    fireEvent.keyDown(getByRole("dialog"), { key: "Escape" });
    expect(onAnswer).toHaveBeenCalledWith("deny");
  });

  it("focuses the primary button on mount", () => {
    const onAnswer = vi.fn();
    const { getByText } = render(
      <PermissionModal request={sampleRequest} onAnswer={onAnswer} />,
    );
    expect(document.activeElement).toBe(getByText("Allow once"));
  });

  it("offers Allow for session and wires the session answer", () => {
    const onAnswer = vi.fn();
    const { getByText } = render(
      <PermissionModal request={sampleRequest} onAnswer={onAnswer} />,
    );
    fireEvent.click(getByText("Allow for session"));
    expect(onAnswer).toHaveBeenCalledWith("session");
  });

  it("renders a delete request (kind badge, action, no preview)", () => {
    const onAnswer = vi.fn();
    const deleteRequest: PermissionRequest = {
      kind: "delete",
      action: "delete file src/old.ts",
      suggestion: "src/**",
    };
    const { getByText, queryByText } = render(
      <PermissionModal request={deleteRequest} onAnswer={onAnswer} />,
    );
    expect(getByText("delete")).toBeTruthy();
    expect(getByText("delete file src/old.ts")).toBeTruthy();
    expect(getByText("Allow once")).toBeTruthy();
    expect(queryByText(/--- remove/)).toBeNull();
  });
});

// The backend (tools/files.ts, tools/apply-patch.ts) sends `preview` as a
// unified diff: '--- from'/'+++ to' headers, '@@ ... @@' hunk markers, then
// ' '/'-'/'+' prefixed lines. DiffPreview colors each line by that prefix.
describe("PermissionModal DiffPreview rendering", () => {
  function renderWithPreview(preview: string) {
    const request: PermissionRequest = {
      kind: "edit",
      action: "edit src/foo.ts",
      preview,
      suggestion: "src/**",
    };
    return render(<PermissionModal request={request} onAnswer={vi.fn()} />);
  }

  it("colors a mixed diff: additions green, removals red, context and hunk header neutral", () => {
    const preview = [
      "--- src/foo.ts",
      "+++ src/foo.ts",
      "@@ -1,3 +1,3 @@",
      " unchanged context",
      "-removed line",
      "+added line",
    ].join("\n");
    const { getByText } = renderWithPreview(preview);
    expect(getByText("-removed line").className).toContain("text-red-400");
    expect(getByText("+added line").className).toContain("text-emerald-400");
    expect(getByText("unchanged context").className).toContain("text-zinc-400");
    expect(getByText("@@ -1,3 +1,3 @@").className).toContain("text-cyan-400");
  });

  it("colors an add-only diff fully green (no removal-colored lines)", () => {
    const preview = ["--- /dev/null", "+++ src/new.ts", "@@ -0,0 +1,2 @@", "+line one", "+line two"].join(
      "\n",
    );
    const { getByText, container } = renderWithPreview(preview);
    expect(getByText("+line one").className).toContain("text-emerald-400");
    expect(getByText("+line two").className).toContain("text-emerald-400");
    const redLines = container.querySelectorAll(".text-red-400");
    expect(redLines.length).toBe(0);
  });

  it("colors a remove-only diff fully red (no addition-colored lines)", () => {
    const preview = [
      "--- src/old.ts",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-line one",
      "-line two",
    ].join("\n");
    const { getByText, container } = renderWithPreview(preview);
    expect(getByText("-line one").className).toContain("text-red-400");
    expect(getByText("-line two").className).toContain("text-red-400");
    const greenLines = container.querySelectorAll(".text-emerald-400");
    expect(greenLines.length).toBe(0);
  });

  it("renders the truncation marker of a large diff with a neutral style", () => {
    const preview = [
      "--- src/big.ts",
      "+++ src/big.ts",
      "@@ -1,2 +1,2 @@",
      "-old",
      "+new",
      "... (120 more diff lines)",
    ].join("\n");
    const { getByText } = renderWithPreview(preview);
    expect(getByText("... (120 more diff lines)").className).toContain("text-zinc-500");
  });
});
