/**
 * Per-turn state (section 4.1 of MIGRATION_SPEC).
 *
 * Python tolerates module globals (changes, permissions.ask_handler,
 * question_tool.handler, parallel's emitter) because it is single-user; in the
 * Node server, turns from different sessions run concurrently in the same process.
 * Everything that was a per-turn global lives here, propagated by AsyncLocalStorage
 * when explicit injection does not reach (tools called deep in the stack).
 *
 * Layering rule: imports types.ts only.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { AskOutcome, EmitFn, PermissionKind } from "./types.js";

/**
 * Minimal type of the turn's file-change tracker (/undo).
 * The real implementation (class ChangeTracker) lives in changes.ts; here only the
 * interface, to avoid an import cycle.
 */
export interface ChangeTracker {
  /** resets the snapshots at the start of the turn */
  startTurn(): void;
  /** keeps the oldest snapshot per file (before = null: did not exist) */
  record(path: string, before: Buffer | null): void;
  /** undoes the last turn's changes and returns the textual report */
  undo(): string;
}

/**
 * Permission hook (server/front or terminal prompt). The 5 outcomes:
 * once/always/deny answered by the user; cancelled/timeout synthetic.
 */
export type PermissionHandler = (
  kind: PermissionKind,
  action: string,
  preview: string | null,
  suggestion: string,
) => Promise<AskOutcome>;

/** Hook for the question tool; returns the user's answer (or synthetic text). */
export type QuestionHandler = (question: string, options: string[]) => Promise<string>;

/**
 * Sink for background-agent completion notifications. The session owns the single
 * queue (Session implements this); nested agents never own the parent's host.
 */
export interface BgNotifyHost {
  pendingBgNotifications: string[];
}

export interface TurnContext {
  /** turn's /undo tracker; null when undo does not apply (sub-agents) */
  changes: ChangeTracker | null;
  /** null: no front connected (CLI decides between tty prompt and denial) */
  permissionHandler: PermissionHandler | null;
  /** null: non-interactive mode (question replies with the synthetic text) */
  questionHandler: QuestionHandler | null;
  /** user messages arrived mid-turn (steering), in order */
  steerQueue: string[];
  /** cooperative cancellation: emit raises TurnCancelled when set */
  cancel: { set: boolean };
  /** turn's event emitter (used by parallel_agents and the hooks) */
  emit: EmitFn | null;
  /**
   * Owner of the background-notification queue (the session on the main turn;
   * null inside nested sub-agents, so a fork cannot double-deliver).
   */
  bgNotifyHost: BgNotifyHost | null;
  /** Scratch queue reserved for nested turns without a host (currently inert). */
  bgNotifyQueue: string[];
  /** Base directory tools resolve against (a worktree path for isolated agents). */
  toolRoot: string | null;
  /** Deferred-tool names unlocked for this turn via tool_search. */
  enabledDeferred: Set<string>;
  /** false inside sub-agents: the question tool declines instead of blocking. */
  allowQuestion: boolean;
  /**
   * Chars of tool output already returned to the model in this turn.
   * dispatch() accumulates it and aggressively truncates once the aggregate
   * turn budget is exceeded (each TurnContext lives for exactly one turn, so
   * no explicit reset is needed).
   */
  toolOutputChars: number;
}

/** New context with neutral defaults; override what the caller injects. */
export function newTurnContext(partial: Partial<TurnContext> = {}): TurnContext {
  return {
    changes: null,
    permissionHandler: null,
    questionHandler: null,
    steerQueue: [],
    cancel: { set: false },
    emit: null,
    bgNotifyHost: null,
    bgNotifyQueue: [],
    toolRoot: null,
    enabledDeferred: new Set<string>(),
    allowQuestion: true,
    toolOutputChars: 0,
    ...partial,
  };
}

/** Current turn's storage; prefer runWithTurn/currentTurn over direct access. */
export const turnStorage = new AsyncLocalStorage<TurnContext>();

/** Runs fn with ctx as the current turn (visible via currentTurn in the async subtree). */
export function runWithTurn<T>(ctx: TurnContext, fn: () => T): T {
  return turnStorage.run(ctx, fn);
}

/** Current turn's context, or undefined outside a turn. */
export function currentTurn(): TurnContext | undefined {
  return turnStorage.getStore();
}
