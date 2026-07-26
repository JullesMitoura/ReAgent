import { useEffect, useRef, useState } from "react";
import * as api from "../api";
import { useDebouncedValue } from "../hooks/useDebouncedValue";
import { useTheme } from "../hooks/useTheme";
import { prettyPath } from "../paths";
import type { SessionMeta } from "../types";
import { Orb } from "./Orb";

interface Props {
  mode: "detecting" | "live" | "demo";
  /** Diretório que o agente pode ler/editar; mostrado no rodapé. */
  root?: string;
  sessions: SessionMeta[];
  activeId: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onClearAll: () => void;
}

/** Rótulo do atalho de nova conversa, conforme a plataforma (⌘K no macOS). */
export const NEW_CHAT_SHORTCUT = /Mac|iP(hone|ad|od)/.test(
  typeof navigator === "undefined" ? "" : navigator.platform,
)
  ? "⌘K"
  : "Ctrl K";

const DAY = 86_400_000;
const BUCKETS = ["Today", "Yesterday", "Previous 7 days", "Earlier"] as const;
type Bucket = (typeof BUCKETS)[number];

/** Date bucket for a session, from its last-update epoch ms. */
function bucketOf(ms?: number): Bucket {
  if (!ms) return "Earlier";
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ms >= startToday) return "Today";
  if (ms >= startToday - DAY) return "Yesterday";
  if (ms >= startToday - 7 * DAY) return "Previous 7 days";
  return "Earlier";
}

/** Compact relative time ("5m ago", "3h ago", "2d ago"); empty under a minute
 * (the "Today" bucket heading already says it's recent; hidden by the caller). */
function relativeTime(ms?: number): string {
  if (!ms) return "";
  const diff = Date.now() - ms;
  if (diff < 60_000) return "";
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return `${Math.floor(d / 7)}w ago`;
}

/** Alterna claro/escuro; ícone de sol (no escuro, convida a clarear) ou lua (no claro). */
function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === "dark";
  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      title={isDark ? "Switch to light mode" : "Switch to dark mode"}
      className="ml-auto grid h-7 w-7 shrink-0 place-items-center rounded-lg text-zinc-500 light:text-zinc-400 transition-colors hover:bg-white/5 light:hover:bg-zinc-900/5 hover:text-zinc-200 light:hover:text-zinc-700 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-400/40"
    >
      {isDark ? (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="h-4 w-4">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="h-4 w-4">
          <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" />
        </svg>
      )}
    </button>
  );
}

function SessionItem({
  session,
  active,
  onSelect,
  onRename,
  onDelete,
}: {
  session: SessionMeta;
  active: boolean;
  onSelect: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const startEditing = () => {
    setDraft(session.title || "");
    setEditing(true);
  };

  const commit = () => {
    setEditing(false);
    const title = draft.trim();
    if (title && title !== session.title) onRename(session.id, title);
  };

  if (editing) {
    return (
      <div className="relative flex items-center rounded-lg bg-white/5 light:bg-zinc-900/5">
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") setEditing(false);
          }}
          aria-label={`rename session ${session.id}`}
          className="w-full bg-transparent px-3 py-2 text-[13px] text-zinc-100 light:text-zinc-900 caret-cyan-300 outline-none ring-1 ring-inset ring-cyan-400/40 rounded-lg"
        />
      </div>
    );
  }

  return (
    <div
      className={`group/item relative flex items-center rounded-lg transition-colors ${
        active
          ? "bg-cyan-500/10 text-zinc-100 light:text-zinc-900"
          : "text-zinc-400 light:text-zinc-600 hover:bg-white/5 light:hover:bg-zinc-900/5 hover:text-zinc-200 light:hover:text-zinc-800"
      }`}
    >
      {active && (
        <span className="pointer-events-none absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-cyan-400" />
      )}
      <button
        onClick={() => onSelect(session.id)}
        onDoubleClick={startEditing}
        className="min-w-0 flex-1 px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-cyan-400/40"
      >
        <div className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-[13px]">{session.title || "(untitled)"}</span>
          {relativeTime(session.updatedAtMs) && (
            <span className="shrink-0 text-[10px] text-zinc-600 light:text-zinc-400 group-hover/item:hidden">
              {relativeTime(session.updatedAtMs)}
            </span>
          )}
        </div>
        {session.snippet && (
          <div className="mt-0.5 truncate text-[11px] text-zinc-500">{session.snippet}</div>
        )}
      </button>
      <button
        onClick={startEditing}
        aria-label={`rename session ${session.id}`}
        title="Rename"
        className="grid h-7 w-6 shrink-0 place-items-center rounded text-zinc-600 light:text-zinc-400 opacity-0 transition-colors hover:text-cyan-300 light:hover:text-cyan-600 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-400/40 group-hover/item:opacity-100"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className="h-3 w-3"
        >
          <path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
        </svg>
      </button>
      <button
        onClick={() => onDelete(session.id)}
        aria-label={`delete session ${session.id}`}
        title="Delete"
        className="mr-1 grid h-7 w-6 shrink-0 place-items-center rounded text-zinc-600 light:text-zinc-400 opacity-0 transition-colors hover:text-red-400 light:hover:text-red-600 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-400/40 group-hover/item:opacity-100"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden="true"
          className="h-3 w-3"
        >
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </div>
  );
}

type SearchState = "idle" | "loading" | "success" | "error";

export function Sidebar({ mode, root = "", sessions, activeId, onSelect, onNew, onRename, onDelete, onClearAll }: Props) {
  // Preserve the backend order (most-recent first) inside each date bucket.
  const groups = BUCKETS.map((label) => ({
    label,
    items: sessions.filter((s) => bucketOf(s.updatedAtMs) === label),
  })).filter((g) => g.items.length > 0);

  const [query, setQuery] = useState("");
  const trimmedQuery = query.trim();
  const debouncedQuery = useDebouncedValue(trimmedQuery, 250);
  const [searchState, setSearchState] = useState<SearchState>("idle");
  const [results, setResults] = useState<SessionMeta[]>([]);
  const searching = trimmedQuery.length > 0;
  // While the debounce timer hasn't caught up with the latest keystroke yet,
  // treat the search as still loading (avoids a flash of "no matches").
  const pendingDebounce = searching && debouncedQuery !== trimmedQuery;

  useEffect(() => {
    if (!debouncedQuery) {
      setSearchState("idle");
      setResults([]);
      return;
    }
    let cancelled = false;
    setSearchState("loading");
    api
      .searchSessions(debouncedQuery)
      .then((r) => {
        if (cancelled) return;
        setResults(r);
        setSearchState("success");
      })
      .catch(() => {
        if (cancelled) return;
        setSearchState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [debouncedQuery]);

  const isLoading = searching && (pendingDebounce || searchState === "loading");

  return (
    <aside className="flex w-56 shrink-0 flex-col overflow-hidden rounded-2xl border border-white/10 light:border-zinc-900/10 bg-zinc-900/45 light:bg-white/70">
      <div className="flex items-center gap-2.5 px-4 py-4">
        <Orb className="h-5 w-5" />
        <div className="text-sm font-semibold tracking-wide text-zinc-100 light:text-zinc-900">ReAgent</div>
        <ThemeToggle />
      </div>

      {mode === "demo" && (
        <div className="mx-3 mb-3 rounded-lg border border-amber-500/20 bg-amber-500/[0.07] px-3 py-2 text-[11px] leading-relaxed text-amber-100/80 light:text-amber-800">
          Demo mode: no changes will be made on your computer.
        </div>
      )}

      <button
        onClick={onNew}
        title={`New conversation (${NEW_CHAT_SHORTCUT})`}
        className="group mx-3 mb-4 flex items-center gap-2 whitespace-nowrap rounded-lg border border-white/10 light:border-zinc-900/10 px-3 py-2 text-sm text-zinc-300 light:text-zinc-700 transition-colors hover:border-cyan-400/30 hover:bg-white/[0.04] light:hover:bg-zinc-900/[0.04] hover:text-zinc-100 light:hover:text-zinc-900 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-400/60"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden="true"
          className="h-3.5 w-3.5 shrink-0 text-cyan-400/80 transition-transform duration-200 group-hover:rotate-90"
        >
          <path d="M12 5v14M5 12h14" />
        </svg>
        New conversation
        <kbd className="ml-auto font-sans text-[10px] leading-none text-zinc-600 light:text-zinc-400 opacity-0 transition-opacity group-hover:opacity-100">
          {NEW_CHAT_SHORTCUT}
        </kbd>
      </button>

      <div className="relative mx-3 mb-3">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-600 light:text-zinc-400"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && query) {
              e.stopPropagation();
              setQuery("");
            }
          }}
          placeholder="Search conversations…"
          aria-label="Search conversations"
          className="w-full rounded-lg border border-white/10 light:border-zinc-900/10 bg-white/[0.03] light:bg-zinc-900/[0.03] py-1.5 pl-8 pr-7 text-[13px] text-zinc-200 light:text-zinc-800 outline-none transition-colors placeholder:text-zinc-600 light:placeholder:text-zinc-400 focus:border-cyan-400/30 focus:bg-white/[0.05] light:focus:bg-zinc-900/[0.05] focus:ring-1 focus:ring-cyan-400/30"
        />
        {query && (
          <button
            onClick={() => setQuery("")}
            aria-label="Clear search"
            title="Clear search"
            className="absolute right-1.5 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded text-zinc-600 light:text-zinc-400 transition-colors hover:text-zinc-300 light:hover:text-zinc-700 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-400/40"
          >
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true" className="h-3 w-3">
              <path d="M5 5l10 10M15 5L5 15" />
            </svg>
          </button>
        )}
      </div>

      {!searching && (
        <div className="flex items-center justify-between px-4 pb-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-[0.15em] text-zinc-500">
            Sessions
            {sessions.length > 0 && (
              <span className="ml-1.5 font-normal tracking-normal text-zinc-600 light:text-zinc-400">{sessions.length}</span>
            )}
          </span>
          {sessions.length > 0 && (
            <button
              onClick={onClearAll}
              title="Delete all history"
              className="rounded text-[10px] text-zinc-600 light:text-zinc-400 transition-colors hover:text-red-400 light:hover:text-red-600 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-400/40"
            >
              clear all
            </button>
          )}
        </div>
      )}

      <nav className="flex-1 space-y-3 overflow-y-auto px-3 pb-3">
        {searching ? (
          <div aria-live="polite" className="space-y-0.5">
            {isLoading && (
              <div className="animate-pulse px-3 pt-6 text-center font-mono text-[11px] text-zinc-600 light:text-zinc-400">
                Searching…
              </div>
            )}
            {!isLoading && searchState === "error" && (
              <div className="mx-1 mt-2 rounded-lg border border-red-500/20 bg-red-500/[0.06] px-3 py-2 text-[11px] leading-relaxed text-red-300/80 light:text-red-700">
                Search failed. Try again.
              </div>
            )}
            {!isLoading && searchState === "success" && results.length === 0 && (
              <div className="animate-fade px-2 pt-8 text-center">
                <div className="font-mono text-[11px] text-zinc-600 light:text-zinc-400">no matches</div>
                <div className="mt-1 text-[10px] text-zinc-700 light:text-zinc-300">try a different search term</div>
              </div>
            )}
            {!isLoading &&
              searchState === "success" &&
              results.length > 0 &&
              results.map((s) => (
                <SessionItem
                  key={s.id}
                  session={s}
                  active={s.id === activeId}
                  onSelect={onSelect}
                  onRename={onRename}
                  onDelete={onDelete}
                />
              ))}
          </div>
        ) : (
          <>
            {sessions.length === 0 && (
              <div className="animate-fade px-2 pt-8 text-center">
                <div className="font-mono text-[11px] text-zinc-600 light:text-zinc-400">no conversations yet</div>
                <div className="mt-1 text-[10px] text-zinc-700 light:text-zinc-300">start a new one above</div>
              </div>
            )}
            {groups.map((group) => (
              <div key={group.label} className="space-y-0.5">
                <div className="px-3 pb-1 text-[9px] font-semibold uppercase tracking-[0.15em] text-zinc-600 light:text-zinc-400">
                  {group.label}
                </div>
                {group.items.map((s) => (
                  <SessionItem
                    key={s.id}
                    session={s}
                    active={s.id === activeId}
                    onSelect={onSelect}
                    onRename={onRename}
                    onDelete={onDelete}
                  />
                ))}
              </div>
            ))}
          </>
        )}
      </nav>

      {root && (
        <div className="flex items-center justify-between gap-2 border-t border-white/5 light:border-zinc-900/10 px-4 py-2.5 text-[11px]">
          <div className="flex min-w-0 items-center gap-1.5 text-zinc-500" title={root}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5 shrink-0" aria-hidden="true">
              <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
            </svg>
            <span className="truncate font-mono">{prettyPath(root)}</span>
          </div>
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${mode === "live" ? "bg-emerald-400" : "bg-amber-400"}`}
            title={mode === "live" ? "live" : "demo"}
          />
        </div>
      )}
    </aside>
  );
}
