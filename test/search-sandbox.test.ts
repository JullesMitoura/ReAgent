// 1:1 mirror of tests/test_search_sandbox.py (the grep/glob part; the webfetch
// SSRF tests live in webfetch.test.ts). Deliberate adaptation: the external
// target is a file in tmpdir OUTSIDE the ROOT instead of /etc/hostname (which
// does not exist on macOS and forced a skip); the invariant tested is the same,
// a symlink pointing outside the sandbox never appears nor leaks content.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { config } from "../src/config.js";
import { globFiles, grep } from "../src/tools/search.js";

const originalRoot = config.root;
let project: string;
let outside: string;

beforeEach(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), "reagent-search-"));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), "reagent-outside-"));
  config.setRoot(project);
  config.autoApprove = true;
  config.contextFile = false;
});

afterEach(() => {
  config.setRoot(originalRoot);
  fs.rmSync(project, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

describe("search sandbox", () => {
  it("test_grep_skips_symlink_out_of_sandbox", () => {
    // normal file inside the sandbox that MATCHES the pattern
    fs.writeFileSync(path.join(project, "inside.txt"), "localhost is here\n");

    // symlink pointing outside the sandbox, to a sensitive file
    const target = path.join(outside, "hostname");
    fs.writeFileSync(target, "localhost-canary\n");
    fs.symlinkSync(target, path.join(project, "escape.txt"));

    const out = grep("localhost");
    // the internal file with the word appears; the symlink never
    expect(out).toContain("inside.txt");
    expect(out).not.toContain("escape.txt");
    // and the content of the symlink target never leaks
    expect(out).not.toContain("localhost-canary");
  });

  it("test_glob_skips_symlink_out_of_sandbox", () => {
    const target = path.join(outside, "hostname");
    fs.writeFileSync(target, "secret\n");
    fs.symlinkSync(target, path.join(project, "escape.txt"));
    const out = globFiles("*.txt");
    expect(out).not.toContain("escape.txt");
  });

  it("test_symlink_inside_sandbox_still_visible", () => {
    const real = path.join(project, "real.txt");
    fs.writeFileSync(real, "hello world\n");
    fs.symlinkSync(real, path.join(project, "alias.txt"));
    const out = globFiles("*.txt");
    expect(out).toContain("alias.txt");
  });
});
