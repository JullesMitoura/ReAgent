// PATCH /api/sessions/:sid — renomeia a sessão pela UI (sidebar). Valida a
// persistência do título (detalhe e listagem), o trim, o 404 para sessão
// inexistente e o 422 para body sem título ou com título vazio.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/system-prompt.js", () => ({ buildSystemPrompt: () => "sys" }));

import { config } from "../src/config.js";
import { createApp } from "../src/server/app.js";

const originalRoot = config.root;
let project: string;

beforeEach(() => {
  project = config.setRoot(fs.mkdtempSync(path.join(os.tmpdir(), "reagent-rename-")));
});

afterEach(() => {
  config.setRoot(originalRoot);
  fs.rmSync(project, { recursive: true, force: true });
});

function patchTitle(app: ReturnType<typeof createApp>, sid: string, body: unknown): Promise<Response> {
  return app.fetch(
    new Request(`http://localhost/api/sessions/${sid}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

async function createSession(app: ReturnType<typeof createApp>): Promise<string> {
  const res = await app.fetch(new Request("http://localhost/api/sessions", { method: "POST" }));
  return ((await res.json()) as { id: string }).id;
}

describe("session rename", () => {
  it("test_patch_renames_and_persists_trimmed_title", async () => {
    const app = createApp();
    const sid = await createSession(app);

    const res = await patchTitle(app, sid, { title: "  My renamed session  " });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, title: "My renamed session" });

    const detail = (await (
      await app.fetch(new Request(`http://localhost/api/sessions/${sid}`))
    ).json()) as { title: string };
    expect(detail.title).toBe("My renamed session");

    const list = (await (
      await app.fetch(new Request("http://localhost/api/sessions"))
    ).json()) as { id: string; title: string }[];
    expect(list.find((s) => s.id === sid)?.title).toBe("My renamed session");
  });

  it("test_patch_unknown_session_is_404", async () => {
    const app = createApp();
    const res = await patchTitle(app, "does-not-exist", { title: "x" });
    expect(res.status).toBe(404);
  });

  it("test_patch_missing_or_blank_title_is_422", async () => {
    const app = createApp();
    const sid = await createSession(app);
    expect((await patchTitle(app, sid, {})).status).toBe(422);
    expect((await patchTitle(app, sid, { title: "   " })).status).toBe(422);
  });
});
