/**
 * Port of src/main.py: entry point of the `reagent` CLI.
 *
 * Flags (native parseArgs): -p/--prompt, --dir, --yolo, --allow-dangerous,
 * --resume, --continue, --sessions, plus --help/--version. The subcommand
 * `reagent exec ...` delegates to the non-interactive mode (cli/exec.ts).
 *
 * Startup sequence (main.py:307-352): validate() FIRST (unlike exec, which
 * validates last), then --dir/--yolo/--allow-dangerous, --sessions, session
 * resolution, and then the -p mode (one-shot with render) or the interactive
 * REPL.
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { Agent } from "../agent.js";
import { expand } from "../attachments.js";
import { ChangeTracker } from "../changes.js";
import { config } from "../config.js";
import { classify, userMessage } from "../llm/errors.js";
import { getLogger } from "../logs.js";
import { parsePermissionMode } from "../modes.js";
import { Session } from "../session.js";
import { killAllToolProcesses } from "../tools/process-registry.js";
import { claimSignalOwnership } from "../tools/exec-sessions.js";
import { TurnCancelled } from "../agent.js";
import { needsTrustPrompt, promptTrust } from "../trust.js";
import { execMain } from "./exec.js";
import { runRepl, runTurnCancelable } from "./repl.js";
import { c, resolveSession, sessionsTable } from "./slash-commands.js";

const HELP = `reagent - local, private coding agent

usage:
  reagent [options]                 start the interactive REPL
  reagent serve [options]           start the web UI (opens the browser)
  reagent -p "PROMPT" [options]     run a single prompt and exit
  reagent exec "PROMPT" [options]   non-interactive runner (JSON/scripts)

options:
  -p, --prompt TEXT     run a single prompt and exit (non-interactive)
      --json            with -p: emit NDJSON events on stdout (CI/scripts)
      --plan            shorthand for --mode plan
      --mode MODE       default|plan|acceptEdits|bypass|bare
      --coordinator     lead agent orchestrates via sub-agents
      --dir PATH        working directory (default: current directory)
      --yolo            skip permission confirmations (mode=bypass)
      --allow-dangerous let auto-approve cover dangerous commands
      --resume ID       resume a session by id (or list number)
      --continue        resume the most recent session
      --sessions        list saved sessions and exit
      --quiet           minimal output: progress, final answer, errors only
      --verbose         show tool names and summarized arguments
      --debug           show raw tool calls/results, unfiltered
  -h, --help            show this help and exit
      --version         show the version and exit

serve options:
      --port N          port to listen on (default 8787)
      --host ADDR       bind address (default 127.0.0.1; use 0.0.0.0 in containers)
      --dir PATH        working directory
      --no-open         do not open the browser automatically`;

const SERVE_HELP = `options:
      --port N          port to listen on (default 8787)
      --host ADDR       bind address (default 127.0.0.1; use 0.0.0.0 in containers)
      --dir PATH        working directory
      --no-open         do not open the browser automatically
  -h, --help            show this help and exit`;

function packageVersion(): string {
  try {
    const raw = fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8");
    const pkg = JSON.parse(raw) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Current git branch of config.root, or null outside a repo / on error (best-effort, never throws). */
function gitBranch(): string | null {
  try {
    const result = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: config.root,
      encoding: "utf8",
      timeout: 2000,
    });
    if (result.status !== 0) return null;
    const branch = result.stdout.trim();
    return branch && branch !== "HEAD" ? branch : null;
  } catch {
    return null;
  }
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Startup panel with a cyan border (equivalent of rich's Panel.fit). */
function banner(agent: Agent): string {
  const lines: string[] = [
    c.bold("\u2726 ReAgent \u2726"),
    ` - Model: ${c.cyan(config.azureOpenAILLM)}`,
    ` - Directory: ${c.cyan(config.root)}`,
    ` - Session: ${c.cyan(agent.session.id)}`,
  ];
  const branch = gitBranch();
  if (branch) lines.push(` - Branch: ${c.cyan(branch)}`);
  lines.push(` - ${c.dim("/help for commands")}`);
  if (config.autoApprove) {
    lines.push(` - ${c.yellow("--yolo: auto-approve enabled")}`);
  }
  if (config.planMode) {
    lines.push(` - ${c.yellow(`mode: ${config.permissionMode}`)}`);
  } else if (config.permissionMode !== "default") {
    lines.push(` - ${c.yellow(`mode: ${config.permissionMode}`)}`);
  }
  if (config.coordinatorMode) {
    lines.push(` - ${c.yellow("coordinator mode")}`);
  }
  if (config.verbosity !== "normal") {
    lines.push(` - ${c.yellow(`verbosity: ${config.verbosity}`)}`);
  }
  const width = Math.max(...lines.map((l) => stripAnsi(l).length));
  const h = "\u2500";
  const top = c.cyan("\u256D" + h.repeat(width + 2) + "\u256E");
  const bottom = c.cyan("\u2570" + h.repeat(width + 2) + "\u256F");
  const body = lines
    .map(
      (l) =>
        c.cyan("\u2502") +
        " " +
        l +
        " ".repeat(width - stripAnsi(l).length) +
        " " +
        c.cyan("\u2502"),
    )
    .join("\n");
  return `${top}\n${body}\n${bottom}`;
}

/** End-of-session hint on stderr (TTY only; never pollutes the data stdout). */
function printEndHint(agent: Agent): void {
  if (!process.stderr.isTTY) return;
  const u = agent.session.usage;
  const n = (x: number): string => x.toLocaleString("en-US");
  const dot = "\u00b7";
  process.stderr.write(
    c.dim(
      `\nresume with: reagent --continue  ${dot}  ${agent.session.id}\n` +
        `prompt ${n(u.prompt_tokens ?? 0)} ${dot} output ${n(u.completion_tokens ?? 0)} tokens\n`,
    ),
  );
}

/** Resets colors and re-shows the cursor (the REPL/spinner may leave junk). */
function restoreTerminal(): void {
  if (process.stdout.isTTY) {
    process.stdout.write("[0m[?25h"); // reset SGR + re-show the cursor
  }
}

let terminalGuardInstalled = false;
/**
 * Ensures the terminal is restored on any exit (normal exit, explicit exit()
 * or an unhandled exception). Registered only when the CLI actually runs
 * (inside main), never on a simple import of the module.
 */
function installTerminalGuard(): void {
  if (terminalGuardInstalled) return;
  terminalGuardInstalled = true;
  process.on("exit", restoreTerminal);
  process.on("uncaughtException", (err: unknown) => {
    restoreTerminal();
    process.stderr.write(
      (err instanceof Error ? (err.stack ?? err.message) : String(err)) + "\n",
    );
    process.exit(1);
  });
}

/**
 * CLI entry point. Returns the exit code (number) or undefined (0). Never
 * throws on an expected error (validate, --dir, missing session): it prints to
 * stderr and returns the code.
 */
/** Opens the default browser at `url` (best-effort, cross-platform, no deps). */
function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
  } catch {
    // best-effort: the user can open the URL printed above manually
  }
}

/**
 * `reagent serve`: starts the local web server and opens the browser at it, so a
 * single command gives the front-end already talking to the backend. The server
 * keeps the process alive; Ctrl+C stops it.
 */
async function serveCommand(argv: string[]): Promise<number | void> {
  let values: { port?: string; dir?: string; host?: string; "no-open"?: boolean; help?: boolean };
  try {
    values = parseArgs({
      args: argv,
      options: {
        port: { type: "string" },
        dir: { type: "string" },
        host: { type: "string" },
        "no-open": { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: false,
      strict: true,
    }).values;
  } catch (e) {
    process.stderr.write(
      (e instanceof Error ? e.message : String(e)) + "\n\nusage: reagent serve [options]\n\n" + SERVE_HELP + "\n",
    );
    return 2;
  }
  if (values.help) {
    process.stdout.write("usage: reagent serve [options]\n\n" + SERVE_HELP + "\n");
    return 0;
  }
  const { startServer } = await import("../server/main.js");
  try {
    startServer({
      port: values.port !== undefined ? Number.parseInt(values.port, 10) : undefined,
      dir: values.dir,
      host: values.host,
      onReady: (url) => {
        process.stderr.write(
          "\n" + c.bold("ReAgent") + c.dim(" web UI on ") + c.cyan(url) + "\n" +
            c.dim("Ctrl+C to stop") + "\n\n",
        );
        if (!values["no-open"]) openBrowser(url);
      },
    });
  } catch (e) {
    // config.validate() throws when the .env is incomplete
    process.stderr.write((e instanceof Error ? e.message : String(e)) + "\n");
    return 1;
  }
  // the listening socket keeps the process alive until Ctrl+C
  return new Promise<void>(() => {});
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number | void> {
  installTerminalGuard();
  // exec subcommand: delegates the remaining arguments to the non-interactive mode
  // (execMain claims signal ownership itself; unlike serve, it has its own
  // SIGINT-driven turn cancellation to fall back on).
  if (argv[0] === "exec") {
    return execMain(argv.slice(1));
  }
  // serve subcommand: start the web UI (server + browser) from the same binary.
  // Deliberately does NOT claim signal ownership below: the server has no
  // signal handling of its own, so Ctrl+C must keep going through
  // exec-sessions.ts's fallback force-exit (its only way to actually stop).
  if (argv[0] === "serve" || argv[0] === "web") {
    return serveCommand(argv.slice(1));
  }

  // REPL and -p both manage their own SIGINT-driven cancellation below (the
  // REPL's Ctrl+C handling, -p --json's onSigint); tell exec-sessions.ts's
  // fallback signal handler to back off instead of racing it with an
  // unconditional process.exit() (see claimSignalOwnership's doc comment).
  claimSignalOwnership();

  let values: {
    prompt?: string;
    dir?: string;
    yolo?: boolean;
    "allow-dangerous"?: boolean;
    resume?: string;
    continue?: boolean;
    sessions?: boolean;
    help?: boolean;
    version?: boolean;
    json?: boolean;
    plan?: boolean;
    mode?: string;
    coordinator?: boolean;
    quiet?: boolean;
    verbose?: boolean;
    debug?: boolean;
  };
  try {
    values = parseArgs({
      args: argv,
      options: {
        prompt: { type: "string", short: "p" },
        dir: { type: "string" },
        yolo: { type: "boolean" },
        "allow-dangerous": { type: "boolean" },
        resume: { type: "string" },
        continue: { type: "boolean" },
        sessions: { type: "boolean" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean" },
        json: { type: "boolean" },
        plan: { type: "boolean" },
        mode: { type: "string" },
        coordinator: { type: "boolean" },
        quiet: { type: "boolean" },
        verbose: { type: "boolean" },
        debug: { type: "boolean" },
      },
      allowPositionals: false,
      strict: true,
    }).values;
  } catch (e) {
    process.stderr.write((e instanceof Error ? e.message : String(e)) + "\n\n" + HELP + "\n");
    return 2;
  }

  if (values.help) {
    process.stdout.write(HELP + "\n");
    return 0;
  }
  if (values.version) {
    process.stdout.write(packageVersion() + "\n");
    return 0;
  }

  // validate() FIRST (Azure vars required); missing = message + exit 1
  try {
    config.validate();
  } catch (e) {
    process.stderr.write((e instanceof Error ? e.message : String(e)) + "\n");
    return 1;
  }

  // initialize logging early, to create the log file
  const log = getLogger("reagent.cli");

  if (values.dir) {
    try {
      config.setRoot(values.dir);
    } catch (e) {
      process.stderr.write((e instanceof Error ? e.message : String(e)) + "\n");
      return 1;
    }
  }
  if (values.yolo) config.setYolo();
  if (values["allow-dangerous"]) config.setAllowDangerous();
  if (values.plan) config.setPlanMode(true);
  if (values.mode) {
    const m = parsePermissionMode(values.mode);
    if (!m) {
      process.stderr.write(
        `Unknown mode '${values.mode}'. Use: default|plan|acceptEdits|bypass|bare\n`,
      );
      return 2;
    }
    config.setPermissionMode(m);
  }
  if (values.coordinator) config.setCoordinatorMode(true);
  if (values.debug) config.setVerbosity("debug");
  else if (values.verbose) config.setVerbosity("verbose");
  else if (values.quiet) config.setVerbosity("quiet");

  // One-time interactive trust review: a project-committed hooks.json or a
  // dangerous config.json key (auto_approve/allow_dangerous/permission_mode:
  // bypass) was already downgraded to its safe default by config.setRoot()
  // above; this is the chance to actually review and opt back in. TTY only 
  // never blocks a non-interactive run (needsTrustPrompt/promptTrust no-op
  // without one). Recomputing via setRoot() picks up the now-trusted flags.
  if (process.stdin.isTTY && needsTrustPrompt()) {
    if (await promptTrust()) config.setRoot(config.root);
  }

  // log the startup (dir + model only, never the key)
  log.info("startup dir=%s model=%s", config.root, config.azureOpenAILLM);

  if (values.sessions) {
    process.stdout.write(sessionsTable() + "\n");
    return 0;
  }

  let session: Session | undefined;
  if (values.resume) {
    const resolved = resolveSession(values.resume);
    if (resolved === null) {
      process.stderr.write(`Session not found: ${values.resume}\n`);
      return 1;
    }
    session = resolved;
  } else if (values.continue) {
    const latest = Session.latestId();
    if (latest) session = Session.load(latest);
  }
  const agent = new Agent(session);

  if (values.prompt !== undefined) {
    // -p mode: one-shot; --json emits NDJSON events (CI), otherwise terminal render.
    const changes = new ChangeTracker();
    let truncated = false;
    try {
      if (values.json) {
        const { runWithTurn, newTurnContext } = await import("../turn-context.js");
        // Same cancellation wiring as exec.ts/repl.ts: without a real cancel
        // flag reaching the TurnContext, Ctrl+C left this branch's turn
        // running detached (no SIGINT handling here at all previously).
        const cancel = { set: false };
        const emit = (ev: import("../types.js").ServerEvent): void => {
          if (cancel.set) throw new TurnCancelled();
          if (ev.type === "token") return;
          if (ev.type === "done" && ev.truncated) truncated = true;
          if (ev.type === "done") {
            process.stdout.write(
              JSON.stringify({ type: "message", content: ev.content ?? "", truncated: Boolean(ev.truncated) }) + "\n",
            );
          } else {
            process.stdout.write(JSON.stringify(ev) + "\n");
          }
        };
        let onSigintReject: (e: Error) => void = () => {};
        const sigint = new Promise<never>((_, reject) => {
          onSigintReject = reject;
        });
        const onSigint = (): void => {
          cancel.set = true;
          killAllToolProcesses();
          onSigintReject(new TurnCancelled());
        };
        process.on("SIGINT", onSigint);
        try {
          await Promise.race([
            runWithTurn(newTurnContext({ emit, changes, cancel, sessionPermissions: agent.session }), () =>
              agent.runEvents(expand(values.prompt!), emit),
            ),
            sigint,
          ]);
        } finally {
          process.removeListener("SIGINT", onSigint);
        }
      } else {
        await runTurnCancelable(agent, expand(values.prompt), changes, process.stdout, (onCancel) => {
          const handler = (): void => onCancel();
          process.on("SIGINT", handler);
          return () => process.removeListener("SIGINT", handler);
        });
      }
    } catch (e) {
      if (e instanceof TurnCancelled) {
        killAllToolProcesses();
        if (values.json) process.stdout.write(JSON.stringify({ type: "cancelled" }) + "\n");
        return 130;
      }
      if (values.json) {
        process.stdout.write(
          JSON.stringify({ type: "error", message: userMessage(e), error_info: classify(e) }) + "\n",
        );
      }
      process.stderr.write(`LLM call error: ${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    }
    printEndHint(agent);
    // Distinct from 0 so CI scripts can tell "the agent gave up on the round
    // budget" apart from "the task actually finished".
    return truncated ? 3 : 0;
  }

  // Interactive mode: banner + config warnings + REPL.
  process.stdout.write(banner(agent) + "\n");
  // Problems in .reagent/config.json: visible right at startup, never swallowed.
  for (const warn of config.configErrors) {
    process.stdout.write(c.yellow(warn) + "\n");
  }
  await runRepl(agent);
  return 0;
}

// Equivalent of Python's `if __name__ == "__main__"`: when the module is the
// entry point (node/tsx directly), it runs main(). The bin shim imports the
// module and calls main() from outside, so the guard is false (no double invocation).
function isEntryPoint(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return fileURLToPath(import.meta.url) === fs.realpathSync(argv1);
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().then(
    (code) => {
      if (typeof code === "number") process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write((err instanceof Error ? (err.stack ?? err.message) : String(err)) + "\n");
      process.exitCode = 1;
    },
  );
}
