// 1:1 mirror of the webfetch SSRF guard (tests/test_search_sandbox.py) plus the
// gate off by default (test_webfetch_disabled_by_default, from
// tests/test_dispatch.py; here against the webfetch function directly, the
// dispatch arrives in phase 5). No test touches the network, except the
// DNS-rebinding regression tests below, which talk to a local HTTP server only.

import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Agent } from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { config } from "../src/config.js";
import { ToolError } from "../src/tools/errors.js";
import { buildPinnedLookup, isBlockedIp, pinnedDispatcher, webfetch } from "../src/tools/web.js";

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

describe("webfetch: DNS-rebinding TOCTOU (real connection must use the guarded IP, not re-resolve)", () => {
  // A domain reserved by RFC 2606 to never resolve in real DNS. Used to prove
  // the real connection does NOT depend on the hostname's own resolution at
  // connect time: without pinning, undici/Node would try to resolve it itself
  // and fail with ENOTFOUND (this is exactly the gap a short-TTL rebinding
  // domain would exploit: guard-time and connect-time resolution diverging).
  const UNRESOLVABLE_HOST = "this-host-does-not-exist.invalid";

  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("PINNED-CONNECTION-OK");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("sanity check: the reserved hostname really does not resolve on its own", async () => {
    await expect(
      fetch(`http://${UNRESOLVABLE_HOST}:${port}/`, { signal: AbortSignal.timeout(3000) }),
    ).rejects.toThrow();
  });

  it("pinnedDispatcher forces the real connection to the guarded address, ignoring the hostname entirely", async () => {
    // This is the core of the fix: guardHost's resolved+validated IP must be
    // what the socket actually connects to, not whatever the hostname would
    // independently resolve to (or fail to resolve to) at connect time.
    const dispatcher = pinnedDispatcher("127.0.0.1", 4);
    try {
      const resp = await fetch(`http://${UNRESOLVABLE_HOST}:${port}/`, {
        dispatcher: dispatcher as unknown as NonNullable<RequestInit["dispatcher"]>,
        signal: AbortSignal.timeout(3000),
      });
      expect(resp.status).toBe(200);
      expect(await resp.text()).toBe("PINNED-CONNECTION-OK");
    } finally {
      await dispatcher.close().catch(() => {});
    }
  });

  it("the pinned lookup ignores whatever hostname/options it is asked about (simulated rebind)", () => {
    // Simulates the attack directly at the unit that matters: even if the
    // connector asked to resolve a COMPLETELY different name (as a rebinding
    // domain's second DNS answer would, for the exact same registered
    // hostname), the override never consults real DNS again - it always hands
    // back the one address that was validated by the guard.
    const lookup = buildPinnedLookup("93.184.216.34", 4);

    const allResults: unknown[] = [];
    lookup("attacker-rebind-target.example", { all: true }, (err, address) => {
      allResults.push({ err, address });
    });
    expect(allResults).toEqual([{ err: null, address: [{ address: "93.184.216.34", family: 4 }] }]);

    // Even asked about the metadata-service hostname itself, or with the
    // single-address (non-`all`) calling convention node:net also uses:
    const singleResults: unknown[] = [];
    lookup("169.254.169.254.attacker.example", undefined, (err, address, family) => {
      singleResults.push({ err, address, family });
    });
    expect(singleResults).toEqual([{ err: null, address: "93.184.216.34", family: 4 }]);
  });
});

describe("webfetch: pinned dispatcher is wired into every real fetch call", () => {
  const originalRoot = config.root;
  const cleanups2: string[] = [];

  beforeEach(() => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "reagent-project-"));
    cleanups2.push(project);
    config.setRoot(project);
    config.autoApprove = true;
    config.contextFile = false;
    config.enableWebfetch = true;
  });

  afterEach(() => {
    config.setRoot(originalRoot);
    while (cleanups2.length) {
      fs.rmSync(cleanups2.pop() as string, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it("webfetch() passes a pinned undici Agent dispatcher to every fetch() call", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response("hello world", { status: 200, headers: { "content-type": "text/plain" } }),
      );
    await webfetch("https://example.com");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const options = fetchSpy.mock.calls[0]?.[1] as { dispatcher?: unknown } | undefined;
    expect(options?.dispatcher).toBeInstanceOf(Agent);
  });
});
