/**
 * Status strings and pure helpers shared by the agent core.
 * Byte-by-byte contract: the front matches status text by substring.
 */

export const STREAM_RETRY_LIMIT = 3;

export const STATUS_COMPACTING = "compacting context...";
export const STATUS_CTX_EXCEEDED = "context window exceeded; compacting and retrying...";
export const STATUS_CTX_EXHAUSTED =
  "context window exceeded even after compaction; try /compact or /clear";
export const STATUS_STREAM_RETRY = (n: number, i: number): string =>
  `stream error; retrying in ${n}s (attempt ${i}/${STREAM_RETRY_LIMIT})`;
export const STATUS_STREAM_PARTIAL = "stream interrupted; partial response kept";
export const STATUS_TRUNCATED = "response truncated by token limit";
export const STATUS_CONTENT_FILTER = "response blocked by content filter";
export const STATUS_STEERED = "user message received mid-turn";

/** Prefixes that mark a result as failure/denial in the terminal output. */
export const RESULT_FAILURE_PREFIXES = [
  "Error",
  "Unexpected error",
  "Argument error",
  "User denied",
];

/** Prefixes dispatch() uses to signal failure (never raises an exception). */
export const TOOL_ERROR_PREFIXES = ["Error", "Argument error", "Unexpected error"];

/** Raised by the server's emit when the turn is cancelled (cooperative interruption). */
export class TurnCancelled extends Error {
  constructor(message = "") {
    super(message);
    this.name = "TurnCancelled";
  }
}

/**
 * One-line summary of a tool result for the terminal: first non-empty
 * line truncated at ~limit chars. "" for empty/whitespace-only.
 */
export function resultSummary(result: string, limit = 120): string {
  let line = "";
  for (const raw of result.split(/\r\n|\r|\n/)) {
    const stripped = raw.trim();
    if (stripped) {
      line = stripped;
      break;
    }
  }
  if (line.length > limit) line = line.slice(0, limit).trimEnd() + "…";
  return line;
}

/** True when the summary indicates a tool error or permission denial. */
export function isFailureResult(summary: string): boolean {
  return RESULT_FAILURE_PREFIXES.some((p) => summary.startsWith(p));
}

/** Test hook: injectable sleep (mirrors monkeypatch of time.sleep). */
export const _testHooks = {
  sleep: (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)),
};
