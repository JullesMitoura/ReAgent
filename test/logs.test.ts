// 1:1 mirror of tests/test_logs.py: file-only logger and redact().

import { afterEach, describe, expect, it } from "vitest";

import { getLogger, Logger, redact, RootLogger } from "../src/logs.js";

const savedKey = process.env.AZURE_OPENAI_KEY;

afterEach(() => {
  if (savedKey === undefined) delete process.env.AZURE_OPENAI_KEY;
  else process.env.AZURE_OPENAI_KEY = savedKey;
});

describe("logs", () => {
  it("test_get_logger_returns_logger", () => {
    const log = getLogger("agent");
    expect(log).toBeInstanceOf(Logger);
    // It is a namespaced child of the 'reagent' root.
    expect(log.name).toBe("reagent.agent");
  });

  it("test_get_logger_does_not_duplicate_handlers", () => {
    getLogger("a");
    const root = getLogger("reagent") as RootLogger;
    const count = root.handlers.length;
    // Repeated calls do not add handlers to the root.
    getLogger("b");
    getLogger("c");
    expect(root.handlers.length).toBe(count);
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it("test_redact_masks_fake_key", () => {
    const fakeKey = "abcd1234efgh5678ijkl9012mnop";
    process.env.AZURE_OPENAI_KEY = fakeKey;
    const out = redact(`calling api with key=${fakeKey} done`);
    expect(out).not.toContain(fakeKey);
    expect(out).toContain("***REDACTED***");
  });

  it("test_redact_masks_long_token_without_env", () => {
    delete process.env.AZURE_OPENAI_KEY;
    const token = "AKIA1234567890QWERTYUIOPZXCV";
    const out = redact(`token ${token}`);
    expect(out).not.toContain(token);
  });

  it("test_redact_handles_empty", () => {
    expect(redact("")).toBe("");
  });
});
