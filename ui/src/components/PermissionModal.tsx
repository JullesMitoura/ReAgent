import { useEffect, useRef, type KeyboardEvent } from "react";
import type { PermissionAnswer, PermissionRequest } from "../types";

interface Props {
  request: PermissionRequest;
  onAnswer: (answer: PermissionAnswer) => void;
}

const FOCUSABLE =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

// Backend previews (tools/files.ts, tools/apply-patch.ts) are a unified diff:
// "--- from" / "+++ to" headers, "@@ -l,s +l,s @@" hunk markers, then lines
// prefixed with ' ' (context), '-' (removal) or '+' (addition). Anything else
// (e.g. the "... (N more diff lines)" truncation marker) falls back to a
// neutral, muted style.
type DiffLineKind = "header" | "hunk" | "add" | "remove" | "context" | "other";

function classifyDiffLine(line: string): DiffLineKind {
  if (line.startsWith("--- ") || line.startsWith("+++ ")) return "header";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "remove";
  if (line.startsWith(" ")) return "context";
  return "other";
}

const DIFF_LINE_CLASS: Record<DiffLineKind, string> = {
  header: "text-zinc-500",
  hunk: "text-cyan-400 light:text-cyan-700",
  add: "bg-emerald-500/10 text-emerald-400 light:text-emerald-700",
  remove: "bg-red-500/10 text-red-400 light:text-red-700",
  context: "text-zinc-400 light:text-zinc-600",
  other: "italic text-zinc-500",
};

/** Diff-style preview: every line colored by its unified-diff prefix. */
function DiffPreview({ text }: { text: string }) {
  return (
    <pre className="mt-3 max-h-56 overflow-auto rounded-md border border-white/10 light:border-zinc-900/10 bg-zinc-950/60 light:bg-zinc-100 p-3 font-mono text-xs leading-relaxed">
      {text.split("\n").map((line, i) => (
        <div key={i} className={DIFF_LINE_CLASS[classifyDiffLine(line)]}>
          {line || " "}
        </div>
      ))}
    </pre>
  );
}

export function PermissionModal({ request, onAnswer }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);

  // Move focus to the primary control on mount, restore on unmount.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    primaryRef.current?.focus();
    return () => previouslyFocused?.focus();
  }, []);

  // Focus trap + Escape (safe default: deny).
  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.stopPropagation();
      onAnswer("deny");
      return;
    }
    if (e.key !== "Tab") return;
    const container = dialogRef.current;
    if (!container) return;
    const focusable = Array.from(
      container.querySelectorAll<HTMLElement>(FOCUSABLE),
    ).filter((el) => !el.hasAttribute("disabled"));
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  const danger = request.kind === "delete";

  return (
    <div className="fixed inset-0 z-50 flex animate-fade items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="permission-modal-title"
        onKeyDown={handleKeyDown}
        className="w-full max-w-lg rounded-lg border border-white/10 light:border-zinc-900/10 bg-zinc-900 light:bg-white p-5 shadow-xl"
      >
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h2 id="permission-modal-title" className="text-sm font-medium text-zinc-100 light:text-zinc-900">
            Permission required
          </h2>
          <span
            className={`font-mono text-[11px] uppercase tracking-wide ${
              danger ? "text-red-400 light:text-red-600" : "text-zinc-500"
            }`}
          >
            {request.kind}
          </span>
        </div>

        <p className="rounded-md border border-white/5 light:border-zinc-900/10 bg-zinc-950/60 light:bg-zinc-100 px-3 py-2 font-mono text-[13px] text-zinc-300 light:text-zinc-700">
          {request.action}
        </p>
        {request.preview && <DiffPreview text={request.preview} />}

        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <button
            onClick={() => onAnswer("deny")}
            className="rounded-md px-3 py-1.5 text-sm text-zinc-400 light:text-zinc-600 transition-colors hover:bg-red-500/10 hover:text-red-300 light:hover:text-red-600 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-500/50"
          >
            Deny
          </button>
          {request.suggestion ? (
            <>
              <button
                onClick={() => onAnswer("session")}
                className="rounded-md px-3 py-1.5 text-sm text-zinc-400 light:text-zinc-600 transition-colors hover:bg-white/5 light:hover:bg-zinc-900/5 hover:text-zinc-200 light:hover:text-zinc-800 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/20"
                title="Allow matching actions until this session ends (not saved to disk)"
              >
                Allow for session
              </button>
              <button
                onClick={() => onAnswer("always")}
                className="rounded-md px-3 py-1.5 text-sm text-zinc-400 light:text-zinc-600 transition-colors hover:bg-white/5 light:hover:bg-zinc-900/5 hover:text-zinc-200 light:hover:text-zinc-800 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/20"
              >
                Always allow <span className="font-mono text-cyan-400 light:text-cyan-700">{request.suggestion}</span>
              </button>
            </>
          ) : null}
          <button
            ref={primaryRef}
            onClick={() => onAnswer("once")}
            className="rounded-md bg-zinc-100 light:bg-zinc-900 px-3 py-1.5 text-sm font-medium text-zinc-900 light:text-zinc-50 transition-colors hover:bg-white light:hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 light:focus-visible:ring-zinc-900/30"
          >
            Allow once
          </button>
        </div>
      </div>
    </div>
  );
}
