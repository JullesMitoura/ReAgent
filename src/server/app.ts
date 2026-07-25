/**
 * Port of src/server.py: ReAgent's local HTTP+SSE server (Hono).
 *
 * Exposes the agent to front-ends (web, VSCode) while keeping the privacy
 * story: it listens only on 127.0.0.1 (bind in main.ts) and the only network
 * egress is still the LLM endpoint. Sessions come from .reagent/sessions/.
 *
 * `createApp()` returns a Hono whose `.fetch` runs in-process (used by the
 * tests and by any embed); `main.ts` does the real bind with serve().
 *
 * Python->Node adaptations (section 4 of MIGRATION_SPEC):
 * - worker thread + queue.Queue become an async worker + async event queue;
 *   the client disconnect comes from the request AbortSignal (not from a poll).
 * - threading.Event (cancel) becomes a shared { set: boolean } object between
 *   the RunningTurn and the agent's TurnContext (same reference).
 * - the _running threading.Lock is trivial on the single-threaded event loop, but
 *   the atomic check-and-register before spinning up the worker (409) is preserved.
 * - the global hooks permissions.ask_handler/question_tool.handler become the
 *   TurnContext handlers, scoped per turn (never module globals).
 * - the module state (_running, pending) mirrors the Python globals; it is
 *   safe because each turn is keyed by a unique session id.
 */

import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";

import { Hono } from "hono";

import { Agent, TurnCancelled } from "../agent.js";
import { expand } from "../attachments.js";
import { config, IGNORED_DIRS, PROTECTED_FILES } from "../config.js";
import { classify, userMessage } from "../llm/errors.js";
import { getLogger } from "../logs.js";
import { Session, SessionNotFoundError } from "../session.js";
import * as shell from "../tools/shell.js";
import { newTurnContext, runWithTurn } from "../turn-context.js";
import type {
  AskOutcome,
  EmitFn,
  PermissionKind,
  ServerEvent,
} from "../types.js";
import fs from "node:fs";
import path from "node:path";

import { staticDir } from "./static.js";

const log = getLogger("server");

// --- contract constants ------------------------------------------------------

/**
 * Marker left in the history when the user interrupts the turn (Codex
 * style): the model must not assume the interrupted actions completed.
 * Byte-for-byte contract (section 3.5 of MIGRATION_SPEC).
 */
export const ABORT_MARKER =
  "The user interrupted this turn on purpose. Tool calls and commands may have " +
  "executed partially; verify state before assuming anything completed.";

// Browser origins allowed by the origin guard (front in dev and the local
// server itself). The server port is injected by createApp (default 8787).
function allowedOrigins(port: number): ReadonlySet<string> {
  return new Set([
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
  ]);
}

// CORS only for the Vite dev server (in production the server itself serves the
// front, same-origin, and CORS never comes into play).
const CORS_ORIGINS: ReadonlySet<string> = new Set([
  "http://localhost:5173",
  "http://127.0.0.1:5173",
]);

// Accepted hosts (anti DNS-rebinding). "testserver" kept for parity with the
// Python TestClient; the port is ignored in the comparison.
const ALLOWED_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "testserver"]);

// --- module state (mirrors the server.py globals) ----------------------------

interface Waiter {
  answer: string;
  fired: boolean;
  resolve: () => void;
  promise: Promise<void>;
}

/** Running turn: cancel interrupts; steer queues user messages.
 *  `session` is the live instance the agent mutates and saves at turn end; a
 *  rename during the turn must go through it or the final save clobbers it. */
export interface RunningTurn {
  cancel: { set: boolean };
  steer: string[];
  session: Session;
}

// Requests awaiting a reply from the front: id -> waiter.
export const _pendingPermissions = new Map<string, Waiter>();
export const _pendingQuestions = new Map<string, Waiter>();
// Running turns: session id -> RunningTurn.
export const _running = new Map<string, RunningTurn>();

/** 8-hex id (Python's uuid4().hex[:8]). */
function hex8(): string {
  return randomBytes(4).toString("hex");
}

function makeWaiter(): Waiter {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { answer: "", fired: false, resolve, promise };
}

// --- SSE ---------------------------------------------------------------------

/**
 * Data-only SSE frame, without event:/id:/retry: fields (server.py:131-132).
 * JSON.stringify does not escape non-ASCII (equivalent to ensure_ascii=False).
 */
export function sseLine(ev: ServerEvent): string {
  return `data: ${JSON.stringify(ev)}\n\n`;
}

/**
 * Async event queue: the worker pushes (never blocks) and the SSE generator
 * calls next() (waits when empty). The null sentinel ends the stream.
 */
class EventQueue {
  private readonly items: (ServerEvent | null)[] = [];
  private readonly waiters: ((v: ServerEvent | null) => void)[] = [];

  push(ev: ServerEvent | null): void {
    const w = this.waiters.shift();
    if (w) w(ev);
    else this.items.push(ev);
  }

  next(): Promise<ServerEvent | null> {
    if (this.items.length > 0) return Promise.resolve(this.items.shift()!);
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

// --- body/query validation (422 in FastAPI-compatible format) ----------------

function unprocessable(
  c: import("hono").Context,
  loc: string[],
  msg: string,
): Response {
  return c.json({ detail: [{ loc, msg, type: "value_error" }] }, 422);
}

// --- app ---------------------------------------------------------------------

/**
 * Builds the Hono app with all routes, SSE and the section 3 security.
 * `port` feeds the origin guard allowlist (default 8787, like the Python).
 */
export function createApp(port = 8787): Hono {
  const app = new Hono();
  const ALLOWED_ORIGINS = allowedOrigins(port);

  // 1) Anti DNS-rebinding: validate the Host header against localhost/127.0.0.1
  //    (port ignored), BEFORE any route. An external name re-resolved
  //    to 127.0.0.1 arrives with Host: evil.com and is rejected here.
  app.use("*", async (c, next) => {
    const raw = c.req.header("host");
    const hostname = raw ? raw.split(":")[0]! : new URL(c.req.url).hostname;
    if (!ALLOWED_HOSTS.has(hostname)) {
      return c.text("Invalid host header", 400);
    }
    await next();
  });

  // 2) CORS only for the Vite origins (5173).
  app.use("/api/*", async (c, next) => {
    const origin = c.req.header("origin");
    if (origin && CORS_ORIGINS.has(origin)) {
      c.header("Access-Control-Allow-Origin", origin);
      c.header("Access-Control-Allow-Methods", "*");
      c.header("Access-Control-Allow-Headers", "*");
    }
    if (c.req.method === "OPTIONS") return c.body(null, 204);
    await next();
  });

  // 3) Origin guard: only on /api/*. A request with an Origin header (browser)
  //    outside the allowlist is blocked; without Origin (curl, same process) passes.
  app.use("/api/*", async (c, next) => {
    const origin = c.req.header("origin");
    if (origin && !ALLOWED_ORIGINS.has(origin)) {
      log.warning("%s %s -> 403 (origin not allowed)", c.req.method, new URL(c.req.url).pathname);
      return c.json({ detail: "origin not allowed" }, 403);
    }
    await next();
  });

  // 4) Access log only for /api/* (method, path, status). Never body nor
  //    headers, to avoid leaking secrets.
  app.use("/api/*", async (c, next) => {
    await next();
    log.info("%s %s -> %d", c.req.method, new URL(c.req.url).pathname, c.res.status);
  });

  // --- routes ----------------------------------------------------------------

  app.get("/api/info", (c) => {
    return c.json({
      model: config.azureOpenAILLM,
      root: config.root,
      context_window: config.contextWindowTokens,
      config_errors: config.configErrors,
    });
  });

  app.get("/api/sessions", (c) => {
    return c.json(Session.list());
  });

  // Declared BEFORE /api/sessions/:sid so it is not captured by the dynamic
  // route (server.py:152-155).
  app.get("/api/sessions/search", (c) => {
    const q = c.req.query("q");
    if (q === undefined) return unprocessable(c, ["query", "q"], "field required");
    return c.json(Session.search(q));
  });

  app.get("/api/files", (c) => {
    const q = c.req.query("q") ?? "";
    const parsedLimit = Number.parseInt(c.req.query("limit") ?? "30", 10);
    const limit = Number.isFinite(parsedLimit) ? parsedLimit : 30;
    return c.json(listFiles(q, limit));
  });

  app.post("/api/sessions", (c) => {
    const agent = new Agent();
    agent.session.save();
    return c.json({ id: agent.session.id });
  });

  app.get("/api/sessions/:sid", (c) => {
    let session: Session;
    try {
      session = Session.load(c.req.param("sid"));
    } catch (e) {
      if (e instanceof SessionNotFoundError) return c.json({ detail: "session not found" }, 404);
      throw e;
    }
    return c.json({
      id: session.id,
      title: session.title,
      messages: session.messages,
      todos: session.todos,
      usage: session.usage,
      // model window alongside the session: the front does not depend on /api/info
      context_window: config.contextWindowTokens,
    });
  });

  app.patch("/api/sessions/:sid", async (c) => {
    const raw = await readTitle(c);
    if (raw === null) return unprocessable(c, ["body", "title"], "field required");
    const title = raw.trim().slice(0, 120);
    if (!title) return unprocessable(c, ["body", "title"], "must not be empty");
    const sid = c.req.param("sid");
    // turno em andamento: renomeia a instância viva (o save do fim do turno
    // preservará o novo título); senão, carrega do disco e regrava
    const entry = _running.get(sid);
    let session: Session;
    if (entry !== undefined) {
      session = entry.session;
    } else {
      try {
        session = Session.load(sid);
      } catch (e) {
        if (e instanceof SessionNotFoundError) return c.json({ detail: "session not found" }, 404);
        throw e;
      }
    }
    session.title = title;
    session.save();
    return c.json({ ok: true, title });
  });

  app.delete("/api/sessions/:sid", (c) => {
    if (!Session.delete(c.req.param("sid"))) {
      return c.json({ detail: "session not found" }, 404);
    }
    return c.json({ ok: true });
  });

  app.delete("/api/sessions", (c) => {
    return c.json({ deleted: Session.deleteAll() });
  });

  app.post("/api/sessions/:sid/stop", (c) => {
    const entry = _running.get(c.req.param("sid"));
    if (entry === undefined) {
      return c.json({ detail: "no running turn for this session" }, 404);
    }
    entry.cancel.set = true;
    // interrupting the turn also kills the running bash, not just the loop
    shell.killActive();
    return c.json({ ok: true });
  });

  app.post("/api/sessions/:sid/steer", async (c) => {
    const body = await readContent(c);
    if (body === null) return unprocessable(c, ["body", "content"], "field required");
    const content = expand(body); // @file attachments, as in /messages
    const entry = _running.get(c.req.param("sid"));
    if (entry === undefined) {
      return c.json({ detail: "no running turn for this session" }, 404);
    }
    entry.steer.push(content);
    return c.json({ queued: true });
  });

  app.post("/api/sessions/:sid/fork", (c) => {
    let forked: Session;
    try {
      forked = Session.fork(c.req.param("sid"));
    } catch (e) {
      if (e instanceof SessionNotFoundError) return c.json({ detail: "session not found" }, 404);
      throw e;
    }
    return c.json({ id: forked.id });
  });

  app.post("/api/permissions/:pid", async (c) => {
    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      return unprocessable(c, ["body", "answer"], "field required");
    }
    const answer = (payload as { answer?: unknown } | null)?.answer;
    if (answer !== "once" && answer !== "always" && answer !== "deny") {
      return unprocessable(c, ["body", "answer"], "unexpected value; permitted: 'once', 'always', 'deny'");
    }
    const entry = _pendingPermissions.get(c.req.param("pid"));
    if (entry === undefined) {
      return c.json({ detail: "permission request not found (expired?)" }, 404);
    }
    entry.answer = answer;
    entry.fired = true;
    entry.resolve();
    return c.json({ ok: true });
  });

  app.post("/api/questions/:qid", async (c) => {
    const body = await readAnswer(c);
    if (body === null) return unprocessable(c, ["body", "answer"], "field required");
    const entry = _pendingQuestions.get(c.req.param("qid"));
    if (entry === undefined) {
      return c.json({ detail: "question not found (expired?)" }, 404);
    }
    entry.answer = body;
    entry.fired = true;
    entry.resolve();
    return c.json({ ok: true });
  });

  app.post("/api/sessions/:sid/messages", async (c) => {
    const sid = c.req.param("sid");
    const content = await readContent(c);
    if (content === null) return unprocessable(c, ["body", "content"], "field required");

    let session: Session;
    try {
      session = Session.load(sid);
    } catch (e) {
      if (e instanceof SessionNotFoundError) return c.json({ detail: "session not found" }, 404);
      throw e;
    }

    // One turn at a time per session: atomic check-and-register (single-threaded
    // event loop) before spinning up the worker. A duplicate responds 409.
    if (_running.has(sid)) {
      return c.json({ detail: "a turn is already running for this session" }, 409);
    }
    const running: RunningTurn = { cancel: { set: false }, steer: [], session };
    _running.set(sid, running);

    const agent = new Agent(session);
    const events = new EventQueue();

    // emit: if cancel is set, raise TurnCancelled (cooperative interruption on the
    // next event); otherwise enqueue.
    const emit: EmitFn = (ev) => {
      if (running.cancel.set) throw new TurnCancelled();
      events.push(ev);
    };

    // Waits for the front: "answered" | "cancelled" (stop) | "timeout".
    // permissionTimeout == 0 means wait forever; the turn cancel is
    // checked every 0.25s in any case.
    const waitAnswer = async (waiter: Waiter): Promise<"answered" | "cancelled" | "timeout"> => {
      const timeout = config.permissionTimeout;
      const deadline = timeout === 0 ? null : performance.now() / 1000 + timeout;
      for (;;) {
        if (await raceWait(waiter, 250)) return "answered";
        if (running.cancel.set) return "cancelled";
        if (deadline !== null && performance.now() / 1000 >= deadline) return "timeout";
      }
    };

    const permissionHandler = async (
      kind: PermissionKind,
      action: string,
      preview: string | null,
      suggestion: string,
    ): Promise<AskOutcome> => {
      const pid = hex8();
      const waiter = makeWaiter();
      waiter.answer = "deny"; // default deny if the entry disappears
      _pendingPermissions.set(pid, waiter);
      // Emit straight to the queue (without going through emit which raises cancel).
      events.push({ type: "permission_request", id: pid, kind, action, preview, suggestion });
      const result = await waitAnswer(waiter);
      _pendingPermissions.delete(pid);
      if (result === "answered") return waiter.answer as AskOutcome;
      // "cancelled" | "timeout": _ask denies with its own neutral message
      return result;
    };

    const questionHandler = async (question: string, options: string[]): Promise<string> => {
      const qid = hex8();
      const waiter = makeWaiter();
      _pendingQuestions.set(qid, waiter);
      events.push({ type: "question_request", id: qid, question, options: options ?? [] });
      const result = await waitAnswer(waiter);
      _pendingQuestions.delete(qid);
      if (result === "answered" && waiter.answer.trim()) return waiter.answer;
      if (result === "cancelled") {
        // the turn is being aborted; the next emit raises TurnCancelled
        return "(turn interrupted before the user answered)";
      }
      return "(user did not answer; choose the best option and proceed)";
    };

    const ctx = newTurnContext({
      changes: null,
      permissionHandler,
      questionHandler,
      steerQueue: running.steer,
      cancel: running.cancel, // same reference as the RunningTurn: /stop propagates
    });

    // worker: runs the agent turn and feeds the event queue.
    const worker = async (): Promise<void> => {
      try {
        await runWithTurn(ctx, () => agent.runEvents(expand(content), emit));
      } catch (e) {
        if (e instanceof TurnCancelled) {
          // Repair the tail (stubs "aborted by user"), leave the interruption
          // marker in the history and persist: the next turn starts from an
          // explicit state, without pretending the actions completed.
          agent.sanitize();
          agent.messages.push({ role: "user", content: ABORT_MARKER });
          agent.session.save();
          events.push({ type: "done", content: "(turn interrupted by user)", aborted: true });
        } else {
          log.error("worker error on session %s: %s", sid, String(e));
          const info = classify(e);
          events.push({
            type: "error",
            message: userMessage(e),
            error_info: { kind: info.kind, http_status: info.http_status },
          });
        }
      } finally {
        _running.delete(sid);
        // Residual window: a steer accepted ({queued: true}) between the agent's
        // finally and the delete above must not be lost; after the delete the endpoint
        // already responds 404, so no new messages come in.
        let leftover = false;
        while (running.steer.length > 0) {
          agent.messages.push({ role: "user", content: running.steer.shift()! });
          leftover = true;
        }
        if (leftover) agent.session.save();
        events.push(null); // sentinel: end of stream
      }
    };

    // Client disconnect: the request AbortSignal sets the cancel; the next
    // emit raises TurnCancelled.
    const signal = c.req.raw.signal;
    if (signal) {
      if (signal.aborted) running.cancel.set = true;
      else signal.addEventListener("abort", () => {
        running.cancel.set = true;
      }, { once: true });
    }

    void worker();

    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        const ev = await events.next();
        if (ev === null) {
          // sentinel: if aborted (stop or disconnect with a live turn), kill the
          // running bash too.
          const aborted = running.cancel.set;
          running.cancel.set = true;
          if (aborted) shell.killActive();
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(sseLine(ev)));
      },
      cancel: () => {
        // client gone: abort the turn and kill the active bash
        running.cancel.set = true;
        shell.killActive();
      },
    });

    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  });

  // --- static: serve the built front at the root, when it exists ------------
  const sdir = staticDir();
  if (sdir !== null) {
    app.get("/*", (c) => serveStatic(c, sdir));
  }

  return app;
}

// --- helpers -----------------------------------------------------------------

/** Reads { content: string } from the body; null when invalid/missing. */
async function readContent(c: import("hono").Context): Promise<string | null> {
  let payload: unknown;
  try {
    payload = await c.req.json();
  } catch {
    return null;
  }
  const content = (payload as { content?: unknown } | null)?.content;
  return typeof content === "string" ? content : null;
}

/** Reads { title: string } from the body; null when invalid/missing. */
async function readTitle(c: import("hono").Context): Promise<string | null> {
  let payload: unknown;
  try {
    payload = await c.req.json();
  } catch {
    return null;
  }
  const title = (payload as { title?: unknown } | null)?.title;
  return typeof title === "string" ? title : null;
}

/** Reads { answer: string } from the body; null when invalid/missing. */
async function readAnswer(c: import("hono").Context): Promise<string | null> {
  let payload: unknown;
  try {
    payload = await c.req.json();
  } catch {
    return null;
  }
  const answer = (payload as { answer?: unknown } | null)?.answer;
  return typeof answer === "string" ? answer : null;
}

/**
 * Race between the waiter's reply and a short timeout (ms). True when the
 * reply arrived; false on timeout (the caller retries). Once `fired`,
 * returns true immediately.
 */
function raceWait(waiter: Waiter, ms: number): Promise<boolean> {
  if (waiter.fired) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      resolve(false);
    }, ms);
    void waiter.promise.then(() => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/**
 * @reference autocomplete: walk pruning IGNORED_DIRS, skipping
 * PROTECTED_FILES, directories with a `/` suffix, case-insensitive substring
 * match, cutoff at limit*10 candidates and ordering (non-prefix, depth, length).
 */
function listFiles(rawQuery: string, limit: number): string[] {
  const query = rawQuery.toLowerCase();
  const root = config.root;
  const cap = limit * 10;
  const results: string[] = [];
  let stop = false;

  const walk = (dir: string, relDir: string): void => {
    if (stop) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const dirs = entries
      .filter((e) => e.isDirectory() && !IGNORED_DIRS.has(e.name))
      .map((e) => e.name)
      .sort();
    const files = entries
      .filter((e) => !e.isDirectory())
      .map((e) => e.name)
      .sort();
    const prefix = relDir ? relDir + "/" : "";
    for (const d of dirs) {
      const rel = prefix + d + "/";
      if (rel.toLowerCase().includes(query)) results.push(rel);
    }
    for (const f of files) {
      if (PROTECTED_FILES.has(f)) continue;
      const rel = prefix + f;
      if (rel.toLowerCase().includes(query)) results.push(rel);
    }
    if (results.length > cap) {
      stop = true;
      return;
    }
    for (const d of dirs) {
      walk(path.join(dir, d), prefix + d);
      if (stop) return;
    }
  };
  walk(root, "");

  results.sort((a, b) => {
    const aStarts = a.toLowerCase().startsWith(query) ? 0 : 1;
    const bStarts = b.toLowerCase().startsWith(query) ? 0 : 1;
    if (aStarts !== bStarts) return aStarts - bStarts;
    const aSlash = (a.match(/\//g) ?? []).length;
    const bSlash = (b.match(/\//g) ?? []).length;
    if (aSlash !== bSlash) return aSlash - bSlash;
    return a.length - b.length;
  });
  return results.slice(0, limit);
}

// minimal content-type map for the built front assets.
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
};

/**
 * Serves a static file from the built front with index.html fallback
 * (html: true, Starlette StaticFiles style). Contained within sdir (no escape).
 */
function serveStatic(c: import("hono").Context, sdir: string): Response {
  let rel = decodeURIComponent(new URL(c.req.url).pathname).replace(/^\/+/, "");
  if (rel === "") rel = "index.html";
  const base = path.resolve(sdir);
  let filePath = path.resolve(base, rel);
  // containment: do not serve outside the static directory
  if (filePath !== base && !filePath.startsWith(base + path.sep)) {
    filePath = path.join(base, "index.html");
  }
  let data: Buffer;
  let served = filePath;
  try {
    const st = fs.statSync(filePath);
    served = st.isDirectory() ? path.join(filePath, "index.html") : filePath;
    data = fs.readFileSync(served);
  } catch {
    // SPA fallback: index.html for unknown front routes
    const indexPath = path.join(base, "index.html");
    try {
      data = fs.readFileSync(indexPath);
      served = indexPath;
    } catch {
      return new Response("Not Found", { status: 404 });
    }
  }
  const type = MIME[path.extname(served).toLowerCase()] ?? "application/octet-stream";
  return new Response(new Uint8Array(data), { status: 200, headers: { "Content-Type": type } });
}
