import { useEffect, useRef, type KeyboardEvent, type RefObject } from "react";

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

interface UseFocusTrapOptions {
  /** Whether the trap is active (the modal is mounted/open). Defaults to true. */
  active?: boolean;
  /** Called when Escape is pressed inside the trap; omit to leave Escape unhandled here. */
  onEscape?: () => void;
}

/**
 * Traps Tab/Shift+Tab focus cycling within a container's focusable descendants
 * while active, and restores focus to whatever was focused before the trap
 * activated once it becomes inactive (or the component unmounts).
 *
 * Doesn't manage initial focus placement inside the dialog (callers differ on
 * which element should get it first) - just wire the returned `onKeyDown` onto
 * the dialog container.
 */
export function useFocusTrap<T extends HTMLElement>(
  containerRef: RefObject<T | null>,
  { active = true, onEscape }: UseFocusTrapOptions = {},
) {
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!active) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    return () => {
      previouslyFocused.current?.focus();
      previouslyFocused.current = null;
    };
  }, [active]);

  function handleKeyDown(e: KeyboardEvent<T>) {
    if (!active) return;
    if (e.key === "Escape" && onEscape) {
      e.stopPropagation();
      e.preventDefault();
      onEscape();
      return;
    }
    if (e.key !== "Tab") return;
    const container = containerRef.current;
    if (!container) return;
    const focusable = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (el) => !el.hasAttribute("disabled"),
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const activeEl = document.activeElement;
    if (e.shiftKey && activeEl === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && activeEl === last) {
      e.preventDefault();
      first.focus();
    }
  }

  return { handleKeyDown };
}
