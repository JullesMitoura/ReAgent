/**
 * Port of tests/test_llm_retry.py: retryDelay with Retry-After from a header and
 * from the error text, caps and jitter. Simple exception stubs in the Node SDK
 * shape (headers directly on the error; body on the `error` property); no network.
 */

import { describe, expect, it } from "vitest";

import { retryDelay } from "../src/llm/errors.js";

class Err extends Error {
  headers?: Headers;
  error?: unknown;

  constructor(message = "", opts: { headers?: Record<string, string>; body?: unknown } = {}) {
    super(message);
    if (opts.headers !== undefined) this.headers = new Headers(opts.headers);
    if (opts.body !== undefined) this.error = opts.body;
  }
}

describe("llm retry", () => {
  it("test_retry_after_ms_header", () => {
    expect(retryDelay(new Err("", { headers: { "retry-after-ms": "1500" } }), 1)).toBe(1.5);
  });

  it("test_retry_after_header_above_old_cap_is_honored", () => {
    // the server's 90s used to be capped at 30s; now it is honored (ceiling of 120s)
    expect(retryDelay(new Err("", { headers: { "retry-after": "90" } }), 1)).toBe(90.0);
  });

  it("test_retry_after_header_capped_at_server_max", () => {
    expect(retryDelay(new Err("", { headers: { "retry-after": "300" } }), 1)).toBe(120.0);
  });

  it("test_message_try_again_in_seconds", () => {
    expect(retryDelay(new Err("Try again in 35 seconds"), 1)).toBe(35.0);
  });

  it("test_message_azure_retry_after_seconds", () => {
    expect(retryDelay(new Err("Rate limit exceeded. Please retry after 7 seconds."), 1)).toBe(7.0);
  });

  it("test_message_milliseconds", () => {
    expect(Math.abs(retryDelay(new Err("Please try again in 1898 ms"), 1) - 1.898)).toBeLessThan(1e-9);
  });

  it("test_message_capped_at_server_max", () => {
    expect(retryDelay(new Err("Please retry after 999 seconds"), 1)).toBe(120.0);
  });

  it("test_body_message_parsed_when_headers_absent", () => {
    const e = new Err("boom", { body: { error: { message: "Please retry after 11 seconds" } } });
    expect(retryDelay(e, 1)).toBe(11.0);
  });

  it("test_bad_header_and_no_pattern_falls_back_to_backoff", () => {
    const e = new Err("no hint here", { headers: { "retry-after": "soon" } });
    const delay = retryDelay(e, 1);
    expect(delay).toBeGreaterThanOrEqual(0.45);
    expect(delay).toBeLessThanOrEqual(0.55);
  });

  it("test_backoff_first_attempt_with_jitter", () => {
    // base 0.5s with +-10% jitter
    const delay = retryDelay(new Err("x"), 1);
    expect(delay).toBeGreaterThanOrEqual(0.45);
    expect(delay).toBeLessThanOrEqual(0.55);
  });

  it("test_backoff_capped_with_jitter", () => {
    // 30s ceiling of the local backoff, with +-10% jitter
    const delay = retryDelay(new Err("x"), 10);
    expect(delay).toBeGreaterThanOrEqual(27.0);
    expect(delay).toBeLessThanOrEqual(33.0);
  });
});
