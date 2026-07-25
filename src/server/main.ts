/**
 * Local HTTP+SSE server bootstrap. Binds ONLY on 127.0.0.1 (default port 8787)
 * and serves the bundled front. Used by the `reagent serve` subcommand and
 * importable programmatically. createApp() (app.ts) is the in-process app.
 *
 * Python->Node adaptation: uvicorn.run(log_level="warning") becomes serve()
 * from @hono/node-server. No banner on stdout: the CLI and the REPL must not be
 * polluted (same file-only logging discipline).
 */

import { parseArgs } from "node:util";

import { serve } from "@hono/node-server";

import { config } from "../config.js";
import { createApp } from "./app.js";

export { createApp } from "./app.js";

export interface ServeOptions {
  port?: number;
  dir?: string;
  /** called once the server is listening, with the base URL. */
  onReady?: (url: string) => void;
}

/** Binds the server on 127.0.0.1 and calls onReady(url) once listening. */
export function startServer(opts: ServeOptions = {}): void {
  const port = opts.port ?? 8787;
  if (opts.dir !== undefined) config.setRoot(opts.dir);
  config.validate();
  const app = createApp(port);
  serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, () => {
    opts.onReady?.(`http://127.0.0.1:${port}`);
  });
}

/** Programmatic/dev entry: parses --dir/--port and starts the server. */
export function main(argv: string[] = process.argv.slice(2)): void {
  const { values } = parseArgs({
    args: argv,
    options: {
      dir: { type: "string" }, // project root the agent may act on
      port: { type: "string" }, // port to listen on (default 8787)
    },
    allowPositionals: false,
  });
  startServer({
    port: values.port !== undefined ? Number.parseInt(values.port, 10) : undefined,
    dir: values.dir,
  });
}
