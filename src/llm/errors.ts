/**
 * Port of src/llm.py (error classification and retry): pure functions that feed
 * the agent's stream retry, exec, and the server's "error" event.
 *
 * Expected error format: APIError instances from the openai package (fields
 * status/code/headers/error), APIConnectionError for network failures, and the
 * three local exceptions below. The Python SDK's "body" lives on the Node SDK's
 * `error` property; the helpers also accept `body` for test stubs.
 *
 * Detection of the local classes by NAME (not by instanceof): survives
 * duplicate copies of the module (src vs dist, vitest's module isolation).
 */

import { APIError } from "openai";

export class StreamTruncatedError extends Error {
  // stream ended without finish_reason or usage: the response dropped mid-way (retryable)
  constructor(message = "") {
    super(message);
    this.name = "StreamTruncatedError";
  }
}

export class ContentFilterError extends Error {
  // response blocked by the provider's content filter (fatal)
  constructor(message = "") {
    super(message);
    this.name = "ContentFilterError";
  }
}

export class ContextWindowExceededError extends Error {
  // request exceeded the context window even after compacting (fatal)
  constructor(message = "") {
    super(message);
    this.name = "ContextWindowExceededError";
  }
}

// STREAM retry: the SDK only redoes the request before the stream starts; a
// drop IN THE MIDDLE of the stream (network, late 429, 5xx) reached the user as
// a failed turn. Short local backoff (0.5s * 2^(n-1), cap 30s, with jitter); an
// explicit server Retry-After (header or text) is honored up to 120s.
const RETRY_BASE_SECONDS = 0.5;
const RETRY_MAX_SECONDS = 30.0;
const RETRY_SERVER_MAX_SECONDS = 120.0;

// "Try again in 35 seconds", "Please retry after 7 seconds", "retry in 1898 ms":
// some providers (Azure included) only report the delay in the error text.
const RETRY_MSG_RE = /(?:try again|retry)\s+(?:in|after)\s*(\d+(?:\.\d+)?)\s*(ms|s|seconds?)/i;

// Provider error codes by category (see classify()).
const CONTENT_FILTER_CODES = new Set([
  "content_filter",
  "content_policy_violation",
  "ResponsibleAIPolicyViolation",
]);
const CONTEXT_LENGTH_CODES = new Set(["context_length_exceeded", "string_above_max_length"]);

// Cap on the message presented to the user (error bodies can be huge).
const USER_MESSAGE_MAX = 2000;

const KIND_PREFIXES: Record<string, string> = {
  quota: "API quota exhausted: ",
  content_filter: "Response blocked by the provider content filter: ",
  context_length: "Context window exceeded: ",
  connection: "Could not reach the LLM endpoint (check AZURE_OPENAI_ENDPOINT, network, and firewall): ",
  unknown:
    "Unexpected error from the LLM endpoint (if this persists, check AZURE_OPENAI_KEY/" +
    "AZURE_OPENAI_LLM/AZURE_OPENAI_API_VERSION in .env): ",
};

export interface Classification {
  kind: string;
  http_status: number | null;
  retryable: boolean;
}

/** Checks the local exceptions by name (robust against a duplicated module). */
function isLocal(err: unknown, name: string): boolean {
  return err instanceof Error && err.name === name;
}

/** Practical equivalent of Python's str(exc) (only the message, without the name). */
function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Raw error body: `error` in the Node SDK, `body` in stubs/ports. */
function rawBody(err: unknown): unknown {
  if (err && typeof err === "object") {
    const o = err as { error?: unknown; body?: unknown };
    return o.error ?? o.body;
  }
  return undefined;
}

/** Body as a dict (or null when absent/non-object). */
function dictBody(err: unknown): Record<string, unknown> | null {
  const body = rawBody(err);
  if (body && typeof body === "object" && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  return null;
}

/**
 * Body search candidates: the SDK sometimes stores the whole envelope
 * ({"error": {...}}) and sometimes only the inner dict; both formats are valid.
 */
function bodyCandidates(body: Record<string, unknown>): Record<string, unknown>[] {
  const inner = body["error"];
  const candidates: Record<string, unknown>[] = [];
  if (inner && typeof inner === "object" && !Array.isArray(inner)) {
    candidates.push(inner as Record<string, unknown>);
  }
  candidates.push(body);
  return candidates;
}

/** Provider error code: err.code or the body's code/type; "" if absent. */
function errorCode(err: unknown): string {
  const code = err && typeof err === "object" ? (err as { code?: unknown }).code : undefined;
  if (typeof code === "string" && code) return code;
  const body = dictBody(err);
  if (body) {
    for (const d of bodyCandidates(body)) {
      for (const key of ["code", "type"] as const) {
        const val = d[key];
        if (typeof val === "string" && val) return val;
      }
    }
  }
  return "";
}

/** HTTP status when the error is an APIError with a response; null otherwise. */
function apiStatus(err: unknown): number | null {
  if (!(err instanceof APIError)) return null;
  return typeof err.status === "number" ? err.status : null;
}

/**
 * Network error outside the SDK (practical equivalent of httpx.HTTPError):
 * undici can leak TypeError("fetch failed")/ECONN* errors in the middle of the
 * stream iteration without the APIConnectionError wrap.
 */
function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  if (
    typeof code === "string" &&
    /^(ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|EHOSTUNREACH|ENETUNREACH|UND_ERR)/.test(code)
  ) {
    return true;
  }
  const msg = err.message.toLowerCase();
  return msg === "fetch failed" || msg === "terminated" || msg.includes("socket hang up");
}

/** True when the request exceeded the model's context window (400). */
export function isContextLengthError(err: unknown): boolean {
  if (isLocal(err, "ContextWindowExceededError")) return true;
  if (apiStatus(err) !== 400) return false;
  if (CONTEXT_LENGTH_CODES.has(errorCode(err))) return true;
  const text = errText(err).toLowerCase();
  return text.includes("context_length") || text.includes("maximum context length");
}

/**
 * Classifies an LLM error: {kind, http_status, retryable}.
 *
 * kinds: quota (429 insufficient_quota, fatal), content_filter (fatal),
 * context_length (fatal), rate_limit (other 429s, retryable), overloaded
 * (>=500, retryable), connection (connection/stream, retryable), unknown (fatal).
 */
export function classify(err: unknown): Classification {
  if (isLocal(err, "ContextWindowExceededError")) {
    return { kind: "context_length", http_status: null, retryable: false };
  }
  if (isLocal(err, "ContentFilterError")) {
    return { kind: "content_filter", http_status: null, retryable: false };
  }
  if (isLocal(err, "StreamTruncatedError")) {
    return { kind: "connection", http_status: null, retryable: true };
  }
  const status = apiStatus(err);
  if (status !== null) {
    const code = errorCode(err);
    if (code === "insufficient_quota") {
      return { kind: "quota", http_status: status, retryable: false };
    }
    if (CONTENT_FILTER_CODES.has(code)) {
      return { kind: "content_filter", http_status: status, retryable: false };
    }
    if (isContextLengthError(err)) {
      return { kind: "context_length", http_status: status, retryable: false };
    }
    if (status === 429) {
      return { kind: "rate_limit", http_status: status, retryable: true };
    }
    if (status >= 500) {
      return { kind: "overloaded", http_status: status, retryable: true };
    }
    return { kind: "unknown", http_status: status, retryable: false };
  }
  // APIError without status = APIConnectionError and the like (network before the response)
  if (err instanceof APIError || isNetworkError(err)) {
    return { kind: "connection", http_status: null, retryable: true };
  }
  return { kind: "unknown", http_status: null, retryable: false };
}

/** True for transient errors (delegated to classify). */
export function isRetryable(err: unknown): boolean {
  return classify(err).retryable;
}

/** User-presentable error message: prefix by type + detail from the body. */
export function userMessage(err: unknown): string {
  let detail = "";
  const body = dictBody(err);
  if (body) {
    for (const d of bodyCandidates(body)) {
      const msg = d["message"];
      if (typeof msg === "string" && msg) {
        detail = msg;
        break;
      }
    }
  }
  if (!detail) detail = errText(err);
  const prefix = KIND_PREFIXES[classify(err).kind] ?? "";
  return (prefix + detail).slice(0, USER_MESSAGE_MAX);
}

type HeadersLike = { get?: unknown } & Record<string, unknown>;

/** Response headers: err.headers in the Node SDK; err.response.headers in stubs. */
function headersOf(err: unknown): HeadersLike | null {
  if (!err || typeof err !== "object") return null;
  const o = err as { headers?: unknown; response?: { headers?: unknown } };
  const h = o.headers ?? o.response?.headers;
  return h && typeof h === "object" ? (h as HeadersLike) : null;
}

/** Case-insensitive read: Headers/Map via get(), plain object by key. */
function headerGet(h: HeadersLike, name: string): string | undefined {
  if (typeof h.get === "function") {
    const v = (h as { get(n: string): unknown }).get(name);
    return typeof v === "string" ? v : undefined;
  }
  for (const key of Object.keys(h)) {
    if (key.toLowerCase() === name) {
      const v = h[key];
      return typeof v === "string" ? v : undefined;
    }
  }
  return undefined;
}

/**
 * Delay (in seconds) before attempt `attempt` (1-based).
 *
 * Order: retry-after-ms header, retry-after header in seconds (HTTP-date falls
 * through), delay quoted in the error text/body (all capped at 120s), otherwise
 * exponential backoff 0.5s * 2^(n-1) capped at 30s with multiplicative jitter
 * 0.9..1.1 applied AFTER the cap.
 */
export function retryDelay(err: unknown, attempt: number): number {
  const headers = headersOf(err);
  if (headers) {
    const ms = headerGet(headers, "retry-after-ms");
    if (ms) {
      const value = Number(ms);
      if (!Number.isNaN(value)) return Math.min(value / 1000.0, RETRY_SERVER_MAX_SECONDS);
    }
    const ra = headerGet(headers, "retry-after");
    if (ra) {
      const value = Number(ra);
      if (!Number.isNaN(value)) return Math.min(value, RETRY_SERVER_MAX_SECONDS);
      // HTTP-date format (non-numeric): falls through to message parsing/backoff
    }
  }
  const body = rawBody(err);
  let bodyText = "";
  if (body !== undefined && body !== null) {
    if (typeof body === "string") {
      bodyText = body;
    } else {
      try {
        bodyText = JSON.stringify(body) ?? "";
      } catch {
        bodyText = String(body);
      }
    }
  }
  const m = RETRY_MSG_RE.exec(`${errText(err)} ${bodyText}`);
  if (m && m[1] && m[2]) {
    let value = Number(m[1]);
    if (m[2].toLowerCase() === "ms") value /= 1000.0;
    return Math.min(value, RETRY_SERVER_MAX_SECONDS);
  }
  return (
    Math.min(RETRY_BASE_SECONDS * 2 ** (attempt - 1), RETRY_MAX_SECONDS) *
    (0.9 + Math.random() * 0.2)
  );
}
