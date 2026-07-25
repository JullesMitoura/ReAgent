// 1:1 mirror of tests/test_session.py: SQLite + FTS5 persistence.
// Fixture `project`: temporary root with autoApprove and contextFile off.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { config } from "../src/config.js";
import { Session } from "../src/session.js";

const originalRoot = config.root;
let project: string;

beforeEach(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), "reagent-session-"));
  config.setRoot(project);
  config.autoApprove = true;
  config.contextFile = false;
});

afterEach(() => {
  config.setRoot(originalRoot);
  fs.rmSync(project, { recursive: true, force: true });
});

function make(title: string, content: string): Session {
  const s = Session.new();
  s.title = title;
  s.messages = [
    { role: "system", content: "sys" },
    { role: "user", content },
  ];
  s.save();
  return s;
}

describe("session", () => {
  it("test_save_load_roundtrip", () => {
    const s = make("roundtrip", "hello world");
    const loaded = Session.load(s.id);
    expect(loaded.title).toBe("roundtrip");
    expect(loaded.messages[1]?.content).toBe("hello world");
  });

  it("test_list_metadata", () => {
    make("first", "a");
    make("second", "b");
    const sessions = Session.list();
    expect(sessions).toHaveLength(2);
    expect(sessions[0]?.title).toBe("second"); // most recent first
    expect(sessions[0]?.messages).toBe(2);
  });

  it("test_search_finds_content", () => {
    make("alpha", "the database migration plan");
    make("beta", "unrelated words");
    const results = Session.search("migration");
    expect(results).toHaveLength(1);
    expect(results[0]?.title).toBe("alpha");
    expect(results[0]?.snippet).toContain("migration");
  });

  it("test_delete_and_delete_all", () => {
    const a = make("a", "x");
    make("b", "y");
    expect(Session.delete(a.id)).toBe(true);
    expect(Session.delete(a.id)).toBe(false);
    expect(Session.deleteAll()).toBe(1);
    expect(Session.list()).toEqual([]);
  });

  it("test_legacy_json_import", () => {
    const dir = path.join(config.stateDir, "sessions");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "old-1.json"),
      JSON.stringify({
        id: "old-1",
        title: "legacy session",
        messages: [{ role: "user", content: "imported content" }],
        todos: [],
        usage: {},
        created_at: 1.0,
        updated_at: 2.0,
      }),
    );
    const sessions = Session.list(); // triggers the conversion
    expect(sessions.some((s) => s.id === "old-1")).toBe(true);
    // legacy .json is converted in place to .jsonl (no separate backup folder)
    expect(fs.existsSync(path.join(dir, "old-1.json"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "old-1.jsonl"))).toBe(true);
    expect(Session.search("imported")[0]?.id).toBe("old-1");
  });
});
