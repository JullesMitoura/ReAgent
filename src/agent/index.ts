/**
 * Agent core public surface. Prefer importing from "../agent.js" (shim) for
 * compatibility with existing CLI/server/tests.
 */

export { Agent } from "./query-engine.js";
export {
  STATUS_COMPACTING,
  STATUS_CONTENT_FILTER,
  STATUS_CTX_EXCEEDED,
  STATUS_CTX_EXHAUSTED,
  STATUS_STEERED,
  STATUS_STREAM_PARTIAL,
  STATUS_STREAM_RETRY,
  STATUS_TRUNCATED,
  STREAM_RETRY_LIMIT,
  TurnCancelled,
  _testHooks,
  isFailureResult,
  resultSummary,
} from "./status.js";
export { runToolLoop, assistantMessage } from "./tool-loop.js";
export { compactSession, hardTruncate, sanitizeMessages, SUMMARY_TEMPLATE } from "./compact.js";
export { streamCompletion, trackUsage } from "./stream.js";
export { queryLoop, runQueryLoop } from "./query.js";
