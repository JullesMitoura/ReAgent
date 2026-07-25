import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { ConfirmModal } from "./ConfirmModal";

afterEach(() => cleanup());

describe("ConfirmModal accessibility", () => {
  it("exposes dialog semantics on the container", () => {
    const { getByRole } = render(
      <ConfirmModal title="Delete?" description="desc" confirmLabel="Delete" onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    const dialog = getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-labelledby")).toBe("confirm-title");
  });

  it("focuses the Cancel button on mount", () => {
    const { getByText } = render(
      <ConfirmModal title="t" description="d" confirmLabel="Delete" onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(document.activeElement).toBe(getByText("Cancel"));
  });

  it("cancels when Escape is pressed", () => {
    const onCancel = vi.fn();
    const { getByRole } = render(
      <ConfirmModal title="t" description="d" confirmLabel="Delete" onConfirm={vi.fn()} onCancel={onCancel} />,
    );
    fireEvent.keyDown(getByRole("dialog"), { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("traps Tab: from the last button it wraps back to Cancel (the first)", () => {
    const { getByRole, getByText } = render(
      <ConfirmModal title="t" description="d" confirmLabel="Delete" onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    getByText("Delete").focus();
    fireEvent.keyDown(getByRole("dialog"), { key: "Tab" });
    expect(document.activeElement).toBe(getByText("Cancel"));
  });

  it("traps Shift+Tab: from Cancel (the first) it wraps to the last button", () => {
    const { getByRole, getByText } = render(
      <ConfirmModal title="t" description="d" confirmLabel="Delete" onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    // Cancel already has focus from the mount effect.
    fireEvent.keyDown(getByRole("dialog"), { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(getByText("Delete"));
  });

  it("restores focus to the previously-focused element after unmount", () => {
    const trigger = document.createElement("button");
    trigger.textContent = "trigger";
    document.body.appendChild(trigger);
    trigger.focus();

    const { unmount } = render(
      <ConfirmModal title="t" description="d" confirmLabel="Delete" onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });
});
