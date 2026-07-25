// 1:1 mirror of the webfetch SSRF guard (tests/test_search_sandbox.py) plus the
// gate off by default (test_webfetch_disabled_by_default, from
// tests/test_dispatch.py; here against the webfetch function directly, the
// dispatch arrives in phase 5). No test touches the network.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { config } from "../src/config.js";
import { ToolError } from "../src/tools/errors.js";
import { isBlockedIp, webfetch } from "../src/tools/web.js";

const originalRoot = config.root;
const cleanups: string[] = [];
let savedEnableEnv: string | undefined;

function mktemp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

beforeEach(() => {
  // ensures the default: without env or config.json, webfetch is off
  savedEnableEnv = process.env.AGENT_ENABLE_WEBFETCH;
  delete process.env.AGENT_ENABLE_WEBFETCH;
  const project = mktemp("reagent-project-");
  config.setRoot(project);
  config.autoApprove = true;
  config.contextFile = false;
});

afterEach(() => {
  if (savedEnableEnv === undefined) delete process.env.AGENT_ENABLE_WEBFETCH;
  else process.env.AGENT_ENABLE_WEBFETCH = savedEnableEnv;
  config.setRoot(originalRoot);
  while (cleanups.length) {
    fs.rmSync(cleanups.pop() as string, { recursive: true, force: true });
  }
});

describe("webfetch ssrf guard", () => {
  it("test_is_blocked_ip_rejects_loopback", () => {
    expect(isBlockedIp("127.0.0.1")).toBe(true);
  });

  it("test_is_blocked_ip_rejects_link_local_metadata", () => {
    expect(isBlockedIp("169.254.169.254")).toBe(true);
  });

  it("test_is_blocked_ip_rejects_private", () => {
    expect(isBlockedIp("10.0.0.1")).toBe(true);
    expect(isBlockedIp("192.168.1.1")).toBe(true);
    expect(isBlockedIp("172.16.0.1")).toBe(true);
  });

  it("test_is_blocked_ip_rejects_unspecified_and_unparseable", () => {
    expect(isBlockedIp("0.0.0.0")).toBe(true);
    expect(isBlockedIp("::")).toBe(true);
    expect(isBlockedIp("not-an-ip")).toBe(true);
  });

  it("test_is_blocked_ip_allows_public", () => {
    expect(isBlockedIp("93.184.216.34")).toBe(false);
  });

  it("test_webfetch_disabled_by_default", async () => {
    expect(config.enableWebfetch).toBe(false);
    await expect(webfetch("https://example.com")).rejects.toThrow(ToolError);
    await expect(webfetch("https://example.com")).rejects.toThrow(
      "webfetch is disabled (enable with AGENT_ENABLE_WEBFETCH=1)",
    );
  });
});
