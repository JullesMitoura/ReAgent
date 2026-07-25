// 1:1 mirror of tests/test_app_protection.py: the agent can never write/delete
// in Reagent's own source code. A hard guarantee in the tool (not just prompt
// guidance): write/edit/delete refuse any path inside the app's src/ or
// code-front/, while reading stays allowed and files outside those folders
// remain writable.
//
// The config.APP_PROTECTED_DIRS monkeypatch becomes an in-place mutation of the
// exported array (the same instance consulted by config.isAppSource), restored
// in afterEach.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { APP_PROTECTED_DIRS, config } from "../src/config.js";
import { ToolError } from "../src/tools/errors.js";
import { deleteFile, editFile, readFile, writeFile } from "../src/tools/files.js";

const originalRoot = config.root;
const originalDirs = APP_PROTECTED_DIRS.slice();
let project: string;

beforeEach(() => {
  project = config.setRoot(fs.mkdtempSync(path.join(os.tmpdir(), "reagent-appsrc-")));
  config.autoApprove = true;
  config.contextFile = false;
});

afterEach(() => {
  APP_PROTECTED_DIRS.length = 0;
  APP_PROTECTED_DIRS.push(...originalDirs);
  config.setRoot(originalRoot);
  fs.rmSync(project, { recursive: true, force: true });
});

/** Simulates the ROOT containing the protected app code (src/). */
function makeFakeApp(): string {
  const appSrc = path.join(project, "src");
  fs.mkdirSync(appSrc);
  fs.writeFileSync(path.join(appSrc, "agent.py"), "REAL = 1\n");
  APP_PROTECTED_DIRS.length = 0;
  APP_PROTECTED_DIRS.push(fs.realpathSync(appSrc));
  config.protectAppSource = true;
  return appSrc;
}

/** Same dispatch mapping for controlled errors: "Error: {msg}". */
async function likeDispatch(fn: () => string | Promise<string>): Promise<string> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ToolError) return `Error: ${err.message}`;
    throw err;
  }
}

describe("app protection", () => {
  it("test_write_into_app_source_is_blocked", async () => {
    const appSrc = makeFakeApp();
    const out = await likeDispatch(() => writeFile("src/new.py", "x = 1"));
    expect(out.toLowerCase()).toContain("access denied");
    expect(fs.existsSync(path.join(appSrc, "new.py"))).toBe(false); // nothing was created
  });

  it("test_overwrite_app_source_is_blocked", async () => {
    const appSrc = makeFakeApp();
    const out = await likeDispatch(() => writeFile("src/agent.py", "WIPED"));
    expect(out.toLowerCase()).toContain("access denied");
    expect(fs.readFileSync(path.join(appSrc, "agent.py"), "utf8")).toBe("REAL = 1\n"); // intact
  });

  it("test_edit_app_source_is_blocked", async () => {
    const appSrc = makeFakeApp();
    const out = await likeDispatch(() => editFile("src/agent.py", "REAL = 1", "REAL = 2"));
    expect(out.toLowerCase()).toContain("access denied");
    expect(fs.readFileSync(path.join(appSrc, "agent.py"), "utf8")).toBe("REAL = 1\n");
  });

  it("test_delete_app_source_is_blocked", async () => {
    const appSrc = makeFakeApp();
    const out = await likeDispatch(() => deleteFile("src/agent.py"));
    expect(out.toLowerCase()).toContain("access denied");
    expect(fs.existsSync(path.join(appSrc, "agent.py"))).toBe(true); // was not removed
  });

  it("test_read_app_source_still_allowed", async () => {
    makeFakeApp();
    const out = await likeDispatch(() => readFile("src/agent.py"));
    expect(out.toLowerCase()).not.toContain("access denied");
    expect(out).toContain("REAL = 1");
  });

  it("test_generated_files_outside_app_source_are_allowed", async () => {
    makeFakeApp();
    const out = await likeDispatch(() => writeFile("output/puzzle.html", "<html></html>"));
    expect(out.toLowerCase()).not.toContain("access denied");
    expect(fs.readFileSync(path.join(project, "output", "puzzle.html"), "utf8")).toBe(
      "<html></html>",
    );
  });

  it("test_toggle_off_allows_writing_app_source", async () => {
    const appSrc = makeFakeApp();
    config.protectAppSource = false; // "protect_app_source": false
    const out = await likeDispatch(() => writeFile("src/new.py", "ok"));
    expect(out.toLowerCase()).not.toContain("access denied");
    expect(fs.readFileSync(path.join(appSrc, "new.py"), "utf8")).toBe("ok");
  });

  it("test_real_reagent_package_is_recognized_as_app_source", () => {
    // Sanity: the real Reagent package is recognized as app source.
    const probe = path.join(APP_PROTECTED_DIRS[0]!, "____probe.py");
    // depends on protectAppSource (default true in the tmp project, without config.json)
    expect(config.isAppSource(probe)).toBe(true);
  });
});
