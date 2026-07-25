// 1:1 mirror of tests/test_attachments.py: guards for @file attachments
// (size and binary). `rooted` fixture: sandbox in an isolated tmp, root
// restored at the end.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { attachReference, MAX_ATTACHMENT_BYTES } from "../src/attachments.js";
import { config } from "../src/config.js";

const originalRoot = config.root;
let rooted: string;
const cleanups: string[] = [];

beforeEach(() => {
  rooted = fs.mkdtempSync(path.join(os.tmpdir(), "reagent-attach-"));
  cleanups.push(rooted);
  config.setRoot(rooted);
  rooted = config.root; // realpath (macOS: /var/folders symlink)
});

afterEach(() => {
  config.setRoot(originalRoot);
  while (cleanups.length) {
    fs.rmSync(cleanups.pop() as string, { recursive: true, force: true });
  }
});

describe("attachments", () => {
  it("test_small_text_file_inlines", () => {
    fs.writeFileSync(path.join(rooted, "note.txt"), "hello world\nsecond line\n", "utf8");
    const out = attachReference("note.txt");
    expect(out).toContain("[Attachment: file note.txt]");
    expect(out).toContain("hello world");
    expect(out).toContain("second line");
  });

  it("test_large_file_skipped", () => {
    const big = "a".repeat(MAX_ATTACHMENT_BYTES + 1024);
    fs.writeFileSync(path.join(rooted, "big.txt"), big, "utf8");
    const out = attachReference("big.txt");
    expect(out).toContain("skipped: file too large");
    expect(out).toContain("read_file");
    expect(out).not.toContain("[Attachment:");
  });

  it("test_binary_file_skipped", () => {
    fs.writeFileSync(path.join(rooted, "blob.bin"), Buffer.from("text\x00more binary\x00stuff", "latin1"));
    const out = attachReference("blob.bin");
    expect(out).toContain("skipped: looks binary");
    expect(out).not.toContain("[Attachment:");
  });

  it("test_env_reference_blocked", () => {
    fs.writeFileSync(path.join(rooted, ".env"), "SECRET=1\n", "utf8");
    const out = attachReference(".env");
    expect(out).toContain("invalid attachment @.env");
    expect(out).not.toContain("SECRET");
  });
});
