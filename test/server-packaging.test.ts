// 1:1 mirror of tests/test_server_packaging.py: front packaging/serving.
// Verifies that staticDir() resolves with index.html and that the root serves text/html.
// Skips gracefully when the front has not been built yet.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/server/app.js";
import { staticDir } from "../src/server/static.js";

const hasStatic = staticDir() !== null;

describe("server packaging", () => {
  it.skipIf(!hasStatic)("test_static_dir_resolves_with_index", () => {
    const s = staticDir();
    expect(s).not.toBeNull();
    expect(fs.statSync(path.join(s!, "index.html")).isFile()).toBe(true);
  });

  it.skipIf(!hasStatic)("test_root_serves_html", async () => {
    const app = createApp();
    const resp = await app.fetch(new Request("http://localhost/"));
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toMatch(/^text\/html/);
  });
});
