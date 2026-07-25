// Robustness of the JSONL session store: atomic write, NUL safety, and
// tolerance to a corrupted trailing line. No fixture: manages setRoot manually.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { config } from "../src/config.js";
import { Session } from "../src/session.js";

// built at runtime so the test source stays plain text (no literal NUL byte)
const NUL = String.fromCharCode(0);

const cleanups: string[] = [];

afterEach(() => {
  while (cleanups.length) {
    fs.rmSync(cleanups.pop() as string, { recursive: true, force: true });
  }
});

/** Points the store at a temporary project (self-contained like the conftest). */
function useTmpProject(): string {
  const originalRoot = config.root;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reagent-sessdb-"));
  cleanups.push(tmp);
  config.setRoot(tmp);
  return originalRoot;
}

describe("session-store", () => {
  it("test_save_writes_jsonl_and_roundtrips", () => {
    const originalRoot = useTmpProject();
    try {
      const s = Session.new();
      s.title = "hello";
      s.messages = [{ role: "user", content: "oi" }];
      s.save();
      const file = path.join(config.stateDir, "sessions", `${s.id}.jsonl`);
      expect(fs.existsSync(file)).toBe(true);
      // one envelope line + one message line
      const lines = fs.readFileSync(file, "utf8").trim().split("\n");
      expect(lines).toHaveLength(2);
      const loaded = Session.load(s.id);
      expect(loaded.title).toBe("hello");
      expect(loaded.messages[0]?.content).toBe("oi");
    } finally {
      config.setRoot(originalRoot);
    }
  });

  it("test_search_with_nul_byte_does_not_raise", () => {
    const originalRoot = useTmpProject();
    try {
      const s = Session.new();
      s.messages = [{ role: "user", content: "abc" }];
      s.save();
      // must not raise even with NUL in the query
      const result = Session.search(`a${NUL}b`);
      expect(Array.isArray(result)).toBe(true);
    } finally {
      config.setRoot(originalRoot);
    }
  });

  it("test_save_with_nul_in_content_does_not_raise", () => {
    const originalRoot = useTmpProject();
    try {
      const s = Session.new();
      s.messages = [{ role: "user", content: `a${NUL}b` }];
      s.save();
      const loaded = Session.load(s.id);
      expect(Array.isArray(loaded.messages)).toBe(true);
      expect(loaded.messages[0]?.content).toBe(`a${NUL}b`);
    } finally {
      config.setRoot(originalRoot);
    }
  });

  it("test_corrupt_trailing_line_is_tolerated", () => {
    const originalRoot = useTmpProject();
    try {
      const s = Session.new();
      s.title = "resilient";
      s.messages = [{ role: "user", content: "keep me" }];
      s.save();
      // simulate a crash mid-append: a garbage half-line at the end
      const file = path.join(config.stateDir, "sessions", `${s.id}.jsonl`);
      fs.appendFileSync(file, '{"role":"assistant","content":"trunca');
      const loaded = Session.load(s.id);
      expect(loaded.title).toBe("resilient");
      expect(loaded.messages[0]?.content).toBe("keep me");
    } finally {
      config.setRoot(originalRoot);
    }
  });
});
