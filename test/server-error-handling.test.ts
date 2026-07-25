// Regression test for the missing app.onError found during the backend
// audit: an exception that escapes a route handler used to fall through to
// Hono's default error handler, which returns plain text (breaking the
// documented `{"detail": "..."}` contract, see docs/CONTRACTS.md) and calls
// console.error directly (bypassing the app's own redacted file logger).

import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/server/app.js";
import { Session } from "../src/session.js";

describe("server error handling", () => {
  it("test_unhandled_error_returns_structured_json_500", async () => {
    const spy = vi.spyOn(Session, "load").mockImplementation(() => {
      throw new Error("disk exploded");
    });
    try {
      const app = createApp();
      const resp = await app.fetch(
        new Request("http://localhost/api/sessions/whatever/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content: "hi" }),
        }),
      );
      expect(resp.status).toBe(500);
      expect(resp.headers.get("content-type")).toContain("application/json");
      expect(await resp.json()).toEqual({ detail: "internal error" });
    } finally {
      spy.mockRestore();
    }
  });
});
