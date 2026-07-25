import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { PermissionModal } from "./PermissionModal";
import type { PermissionRequest } from "../types";

const sampleRequest: PermissionRequest = {
  kind: "edit",
  action: "edit src/index.ts",
  preview: "--- remove line\n--- insert line",
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
