/**
 * Port of tests/test_llm_errors.py: LLM error classification
 * (classify / userMessage / isContextLengthError). Uses real APIError from the
 * openai package; nothing touches the network.
 */

import { describe, expect, it } from "vitest";
import { APIConnectionError, APIError } from "openai";

import {
  ContentFilterError,
  ContextWindowExceededError,
  StreamTruncatedError,
  classify,
  isContextLengthError,
  isRetryable,
  userMessage,
} from "../src/llm/errors.js";

// Mirror of Python's _api_error: APIStatusError(message, response, body).
// In the Node SDK the body lives on the `error` property; the message is
// overridden to mirror Python's str(exc) (without makeMessage's "status " prefix).
function apiError(
  status: number,
  body: Record<string, unknown> | null = null,
  message = "boom",
): APIError {
  const err = new APIError(status, body ?? undefined, message, new Headers());
  err.message = message;
  return err;
}

describe("llm errors", () => {
  it("test_quota_429_is_fatal", () => {
    const exc = apiError(429, { error: { code: "insufficient_quota" } });
    const info = classify(exc);
    expect(info).toEqual({ kind: "quota", http_status: 429, retryable: false });
    expect(isRetryable(exc)).toBe(false);
  });

  it("test_plain_429_is_retryable_rate_limit", () => {
    const exc = apiError(429);
    const info = classify(exc);
    expect(info.kind).toBe("rate_limit");
    expect(info.retryable).toBe(true);
    expect(isRetryable(exc)).toBe(true);
  });

  it("test_content_filter_400_is_fatal", () => {
    for (const code of ["content_filter", "content_policy_violation", "ResponsibleAIPolicyViolation"]) {
      const exc = apiError(400, { error: { code } });
      const info = classify(exc);
      expect(info.kind).toBe("content_filter");
      expect(info.retryable).toBe(false);
    }
  });

  it("test_context_length_400_is_fatal_and_detected", () => {
    const exc = apiError(400, { error: { code: "context_length_exceeded" } });
    expect(classify(exc).kind).toBe("context_length");
    expect(isRetryable(exc)).toBe(false);
    expect(isContextLengthError(exc)).toBe(true);
  });

  it("test_context_length_detected_by_message_text", () => {
    const exc = apiError(400, null, "This model's maximum context length is 128000 tokens");
    expect(isContextLengthError(exc)).toBe(true);
  });

  it("test_is_context_length_error_negatives", () => {
    expect(isContextLengthError(apiError(429))).toBe(false);
    expect(isContextLengthError(apiError(500))).toBe(false);
    expect(isContextLengthError(apiError(400))).toBe(false); // generic 400
    expect(isContextLengthError(new Error("nope"))).toBe(false);
  });

  it("test_5xx_is_retryable_overloaded", () => {
    const exc = apiError(503);
    const info = classify(exc);
    expect(info.kind).toBe("overloaded");
    expect(info.retryable).toBe(true);
  });

  it("test_generic_400_is_unknown_fatal", () => {
    const info = classify(apiError(400));
    expect(info.kind).toBe("unknown");
    expect(info.retryable).toBe(false);
  });

  it("test_connection_error_is_retryable", () => {
    const exc = new APIConnectionError({});
    const info = classify(exc);
    expect(info.kind).toBe("connection");
    expect(info.retryable).toBe(true);
  });

  it("test_local_exception_kinds", () => {
    expect(classify(new StreamTruncatedError()).retryable).toBe(true);
    expect(classify(new ContentFilterError()).kind).toBe("content_filter");
    expect(classify(new ContextWindowExceededError("x")).kind).toBe("context_length");
    expect(classify(new Error("x")).kind).toBe("unknown");
  });

  it("test_user_message_prefix_and_truncation", () => {
    const longDetail = "x".repeat(5000);
    const exc = apiError(429, { error: { code: "insufficient_quota", message: longDetail } });
    const msg = userMessage(exc);
    expect(msg.startsWith("API quota exhausted: ")).toBe(true);
    expect(msg.length).toBeLessThanOrEqual(2000);
  });

  it("test_user_message_context_length_prefix", () => {
    const exc = apiError(400, { error: { code: "context_length_exceeded", message: "too long" } });
    expect(userMessage(exc)).toBe("Context window exceeded: too long");
  });

  it("test_user_message_malformed_body_does_not_crash", () => {
    const exc = apiError(500, { error: "not a dict" });
    expect(userMessage(exc)).toContain("boom"); // falls back to str(exc), without throwing
  });

  it("test_user_message_flat_body_shape", () => {
    // the SDK sometimes stores only the error's inner dict in body
    const exc = apiError(429, { code: "insufficient_quota", message: "no quota" });
    expect(userMessage(exc)).toBe("API quota exhausted: no quota");
  });
});
