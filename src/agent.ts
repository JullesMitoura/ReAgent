/**
 * Compatibility shim: public API of the agentic loop.
 * Implementation lives under src/agent/ (query-engine, stream, compact, tool-loop).
 */

export {
  Agent,
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
  runToolLoop,
  assistantMessage,
  compactSession,
  hardTruncate,
  sanitizeMessages,
  SUMMARY_TEMPLATE,
  streamCompletion,
  trackUsage,
  queryLoop,
  runQueryLoop,
} from "./agent/index.js";
