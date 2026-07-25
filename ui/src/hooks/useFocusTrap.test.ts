import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useFocusTrap } from "./useFocusTrap";

function fakeKeyDown(key: string, shiftKey = false) {
  return {
    key,
    shiftKey,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as ReactKeyboardEvent<HTMLDivElement>;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("useFocusTrap", () => {
  it("Tab from the last focusable element wraps back to the first", () => {
    const container = document.createElement("div");
    const a = document.createElement("button");
    const b = document.createElement("button");
    container.append(a, b);
    document.body.appendChild(container);

    const { result } = renderHook(() => useFocusTrap({ current: container }));

    b.focus();
    expect(document.activeElement).toBe(b);
    result.current.handleKeyDown(fakeKeyDown("Tab"));
    expect(document.activeElement).toBe(a);
  });

  it("Shift+Tab from the first focusable element wraps to the last", () => {
    const container = document.createElement("div");
    const a = document.createElement("button");
    const b = document.createElement("button");
    container.append(a, b);
    document.body.appendChild(container);

    const { result } = renderHook(() => useFocusTrap({ current: container }));

    a.focus();
    expect(document.activeElement).toBe(a);
    result.current.handleKeyDown(fakeKeyDown("Tab", true));
    expect(document.activeElement).toBe(b);
  });

  it("ignores disabled focusable candidates when computing first/last", () => {
    const container = document.createElement("div");
    const a = document.createElement("button");
    const disabled = document.createElement("button");
    disabled.setAttribute("disabled", "");
    const b = document.createElement("button");
    container.append(a, disabled, b);
    document.body.appendChild(container);

    const { result } = renderHook(() => useFocusTrap({ current: container }));

    b.focus();
    result.current.handleKeyDown(fakeKeyDown("Tab"));
    expect(document.activeElement).toBe(a);
  });

  it("calls onEscape and stops the event when Escape is pressed", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const onEscape = vi.fn();

    const { result } = renderHook(() => useFocusTrap({ current: container }, { onEscape }));
    const evt = fakeKeyDown("Escape");
    result.current.handleKeyDown(evt);

    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(evt.preventDefault).toHaveBeenCalled();
    expect(evt.stopPropagation).toHaveBeenCalled();
  });

  it("does nothing when inactive", () => {
    const container = document.createElement("div");
    const a = document.createElement("button");
    const b = document.createElement("button");
    container.append(a, b);
    document.body.appendChild(container);
    const onEscape = vi.fn();

    const { result } = renderHook(() => useFocusTrap({ current: container }, { active: false, onEscape }));

    b.focus();
    result.current.handleKeyDown(fakeKeyDown("Tab"));
    expect(document.activeElement).toBe(b); // unchanged, trap inactive

    result.current.handleKeyDown(fakeKeyDown("Escape"));
    expect(onEscape).not.toHaveBeenCalled();
  });

  it("restores focus to the previously-focused element once deactivated", () => {
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();

    const container = document.createElement("div");
    const inner = document.createElement("button");
    container.appendChild(inner);
    document.body.appendChild(container);

    const { rerender } = renderHook(({ active }) => useFocusTrap({ current: container }, { active }), {
      initialProps: { active: true },
    });

    // Simulate the modal moving focus inside itself after opening.
    inner.focus();
    expect(document.activeElement).toBe(inner);

    rerender({ active: false });
    expect(document.activeElement).toBe(outside);
  });
});
