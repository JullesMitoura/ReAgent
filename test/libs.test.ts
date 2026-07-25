// Tests for the foundation libs: head-tail-buffer (name mirrored from
// tests/test_exec_sessions.py), env-scrub (names mirrored from the scrub
// tests of tests/test_shell.py, here at the lib level) and doom-loop (new
// helper; literal messages from Appendix B).

import { afterEach, describe, expect, it } from "vitest";

import {
  DOOM_LOOP_THRESHOLD,
  DoomLoopDetector,
  doomLoopMessage,
  doomLoopWorkerMessage,
} from "../src/lib/doom-loop.js";
import { scrubbedEnv } from "../src/lib/env-scrub.js";
import { capHeadTail, HeadTailBuffer, holdIncompleteUtf8 } from "../src/lib/head-tail-buffer.js";

describe("head-tail-buffer", () => {
  it("test_head_tail_buffer_cap", () => {
    const buf = new HeadTailBuffer(100);
    buf.append("a".repeat(80));
    buf.append("b".repeat(80));
    buf.append("c".repeat(80));
    const out = buf.take();
    expect(out).toContain("[140 chars omitted]");
    expect(out.startsWith("a".repeat(50))).toBe(true);
    expect(out.endsWith("c".repeat(50))).toBe(true);
    expect(buf.take()).toBe(""); // cursor: increment already delivered
  });

  it("test_poll_increment_cap", () => {
    const text = "h".repeat(20000) + "t".repeat(20000);
    const capped = capHeadTail(text, 30000);
    expect(capped).toContain("[10000 chars omitted]");
    expect(capped.length).toBeLessThan(31000);
  });

  it("test_hold_incomplete_utf8_returns_carry", () => {
    // "é" in UTF-8 = 0xC3 0xA9; chunk ends in the middle of the sequence
    const chunk = Buffer.concat([Buffer.from("ol", "utf8"), Buffer.from([0xc3])]);
    const [whole, carry] = holdIncompleteUtf8(chunk);
    expect(whole.toString("utf8")).toBe("ol");
    expect(Array.from(carry)).toEqual([0xc3]);
    // complete sequence in the next chunk decodes fully
    const next = Buffer.concat([carry, Buffer.from([0xa9])]);
    const [whole2, carry2] = holdIncompleteUtf8(next);
    expect(whole2.toString("utf8")).toBe("é");
    expect(carry2.length).toBe(0);
    // pure ASCII holds nothing back
    const ascii = Buffer.from("plain", "utf8");
    const [whole3, carry3] = holdIncompleteUtf8(ascii);
    expect(whole3.toString("utf8")).toBe("plain");
    expect(carry3.length).toBe(0);
  });
});

describe("env-scrub", () => {
  const touched: string[] = [];
  const saved = new Map<string, string | undefined>();

  function setEnv(name: string, value: string): void {
    if (!saved.has(name)) saved.set(name, process.env[name]);
    touched.push(name);
    process.env[name] = value;
  }

  afterEach(() => {
    while (touched.length) {
      const name = touched.pop() as string;
      const original = saved.get(name);
      if (original === undefined) delete process.env[name];
      else process.env[name] = original;
    }
    saved.clear();
  });

  it("test_secret_env_var_is_scrubbed", () => {
    setEnv("AZURE_OPENAI_KEY", "super-secret-value");
    const env = scrubbedEnv();
    expect(env["AZURE_OPENAI_KEY"]).toBeUndefined();
    expect(JSON.stringify(env)).not.toContain("super-secret-value");
  });

  it("test_generic_secret_substring_is_scrubbed", () => {
    setEnv("MY_API_TOKEN", "leaked-token-123");
    const env = scrubbedEnv();
    expect(env["MY_API_TOKEN"]).toBeUndefined();
    expect(JSON.stringify(env)).not.toContain("leaked-token-123");
  });

  it("test_non_secret_env_var_survives", () => {
    setEnv("REAGENT_PLAIN_VALUE", "visible-42");
    const env = scrubbedEnv();
    expect(env["REAGENT_PLAIN_VALUE"]).toBe("visible-42");
  });

  it("test_azure_exact_keys_are_scrubbed_without_substring_hit", () => {
    // ENDPOINT/LLM/API_VERSION do not contain KEY/SECRET/TOKEN/...: caught by the exact list
    setEnv("AZURE_OPENAI_ENDPOINT", "https://example.openai.azure.com");
    setEnv("AZURE_OPENAI_LLM", "gpt-x");
    setEnv("AZURE_OPENAI_API_VERSION", "2024-12-01-preview");
    const env = scrubbedEnv();
    expect(env["AZURE_OPENAI_ENDPOINT"]).toBeUndefined();
    expect(env["AZURE_OPENAI_LLM"]).toBeUndefined();
    expect(env["AZURE_OPENAI_API_VERSION"]).toBeUndefined();
  });

  it("test_lowercase_secret_name_is_scrubbed", () => {
    // substring checked on the uppercased name (fail-closed)
    setEnv("my_password", "hunter2");
    const env = scrubbedEnv();
    expect(env["my_password"]).toBeUndefined();
  });

  it("scrubs DATABASE_URL and AUTH-style names but keeps SSH_AUTH_SOCK", () => {
    setEnv("DATABASE_URL", "postgres://user:pass@localhost/db");
    setEnv("MY_AUTH_HEADER", "Bearer xyz");
    setEnv("CONNECTION_STRING", "Server=.;Password=x");
    setEnv("SSH_AUTH_SOCK", "/tmp/ssh-agent.sock");
    const env = scrubbedEnv();
    expect(env["DATABASE_URL"]).toBeUndefined();
    expect(env["MY_AUTH_HEADER"]).toBeUndefined();
    expect(env["CONNECTION_STRING"]).toBeUndefined();
    expect(env["SSH_AUTH_SOCK"]).toBe("/tmp/ssh-agent.sock");
  });
});

describe("doom-loop", () => {
  it("test_doom_loop_message_is_literal", () => {
    expect(DOOM_LOOP_THRESHOLD).toBe(3);
    expect(doomLoopMessage("grep")).toBe(
      "Error: this exact grep call was repeated 3 times in a row with " +
        "identical arguments; the result will not change. Do not repeat it. " +
        "Reassess your approach, or ask the user with the question tool.",
    );
  });

  it("test_doom_loop_worker_message_is_literal", () => {
    expect(doomLoopWorkerMessage("grep")).toBe(
      "Error: this exact grep call was repeated 3 times in a row with " +
        "identical arguments; the result will not change. " +
        "Change your approach or finish with your report.",
    );
  });

  it("test_doom_loop_triggers_on_third_identical_call", () => {
    const det = new DoomLoopDetector();
    expect(det.record("grep", '{"pattern":"x"}')).toBe(false);
    expect(det.record("grep", '{"pattern":"x"}')).toBe(false);
    expect(det.record("grep", '{"pattern":"x"}')).toBe(true);
    // a fourth identical call stays in the loop (the last 3 remain equal, as in Python)
    expect(det.record("grep", '{"pattern":"x"}')).toBe(true);
  });

  it("test_doom_loop_resets_on_different_call", () => {
    const det = new DoomLoopDetector();
    expect(det.record("grep", '{"pattern":"x"}')).toBe(false);
    expect(det.record("grep", '{"pattern":"x"}')).toBe(false);
    // different arguments break the sequence
    expect(det.record("grep", '{"pattern":"y"}')).toBe(false);
    expect(det.record("grep", '{"pattern":"x"}')).toBe(false);
    expect(det.record("grep", '{"pattern":"x"}')).toBe(false);
    expect(det.record("grep", '{"pattern":"x"}')).toBe(true);
  });
});
