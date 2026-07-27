/**
 * Port of src/exec_cli.py: non-interactive mode (`codex exec` style).
 *
 * Runs a single prompt to completion and exits: useful for scripts, pipelines and
 * CI. Without --json, it prints only the final text to stdout (status and errors
 * go to stderr). With --json, each turn event becomes a JSON line on stdout; the
 * tokens are aggregated and emitted as {"type":"message","content":...} at the end.
 *
 * Data contract (stdout) vs UI (stderr): data always on stdout, progress/hint
 * messages always on stderr. Exit codes: 0 success, 1 LLM/API error, 130 on
 * SIGINT (Ctrl+C).
 *
 * Startup order (different from main.ts): set_root/set_yolo/set_allow_dangerous
 * BEFORE config.validate() (exec_cli.py:50-60).
 */

import fs from "node:fs";
import { parseArgs } from "node:util";

import { Agent, TurnCancelled } from "../agent.js";
import { expand } from "../attachments.js";
import { config } from "../config.js";
import { classify, userMessage } from "../llm/errors.js";
import { killAllToolProcesses } from "../tools/process-registry.js";
import { claimSignalOwnership } from "../tools/exec-sessions.js";
import { newTurnContext, runWithTurn } from "../turn-context.js";
import type { ServerEvent } from "../types.js";

const USAGE =
  "usage: reagent exec \"PROMPT\" [--json] [--output-last-message FILE] " +
  "[--dir DIR] [--yolo] [--allow-dangerous]";

/**
 * Entry point for exec mode. Returns the exit code (0/1/130); never throws.
 */
export async function execMain(argv: string[]): Promise<number> {
  // This entry point manages its own SIGINT-driven turn cancellation below;
  // tell exec-sessions.ts's fallback signal handler to back off instead of
  // racing it with an unconditional process.exit() (idempotent alongside
  // main.ts's own call when invoked via the `reagent exec` subcommand).
  claimSignalOwnership();
  let values: {
    json?: boolean;
    "output-last-message"?: string;
    dir?: string;
    yolo?: boolean;
    "allow-dangerous"?: boolean;
    help?: boolean;
  };
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: argv,
      options: {
        json: { type: "boolean" },
        "output-last-message": { type: "string" },
        dir: { type: "string" },
        yolo: { type: "boolean" },
        "allow-dangerous": { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: true,
      strict: true,
    });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (e) {
    process.stderr.write((e instanceof Error ? e.message : String(e)) + "\n" + USAGE + "\n");
    return 2;
  }

  if (values.help) {
    process.stdout.write(USAGE + "\n");
    return 0;
  }

  const prompt = positionals[0];
  if (prompt === undefined) {
    process.stderr.write("error: prompt is required\n" + USAGE + "\n");
    return 2;
  }

  const asJson = Boolean(values.json);

  // set_root/yolo/allow-dangerous BEFORE validate (exec_cli.py order)
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
  try {
    config.validate();
  } catch (e) {
    process.stderr.write((e instanceof Error ? e.message : String(e)) + "\n");
    return 1;
  }

  const outJson = (ev: Record<string, unknown>): void => {
    process.stdout.write(JSON.stringify(ev) + "\n");
  };

  // Same object referenced by the TurnContext below: setting it is what
  // actually stops the agent loop (via emit throwing TurnCancelled on the
  // next event), not just the race against `sigint`. Without it the turn kept
  // running detached after Ctrl+C — more LLM/tool calls, its own session.save()
  // racing a later invocation — exactly the CLI/REPL gap fixed in repl.ts.
  const cancel = { set: false };
  let truncated = false;
  const emit = (ev: ServerEvent): void => {
    if (cancel.set) throw new TurnCancelled();
    if (ev.type === "token") return; // aggregated: the full text is emitted at the end
    if (ev.type === "done" && ev.truncated) truncated = true;
    if (asJson) {
      if (ev.type === "done") {
        outJson({ type: "message", content: ev.content ?? "", truncated: Boolean(ev.truncated) });
      } else {
        outJson(ev as unknown as Record<string, unknown>);
      }
    } else if (ev.type === "status") {
      process.stderr.write((ev.text ?? "") + "\n");
    }
  };

  // New session, persisted normally (can be resumed later with --resume).
  const agent = new Agent();

  // Ctrl+C: kills the active bash and ends the turn with exit 130.
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

  let final: string;
  try {
    final = await Promise.race([
      runWithTurn(newTurnContext({ emit, cancel, sessionPermissions: agent.session }), () =>
        agent.runEvents(expand(prompt), emit),
      ),
      sigint,
    ]);
  } catch (e) {
    if (e instanceof TurnCancelled) {
      if (asJson) outJson({ type: "cancelled" });
      return 130;
    }
    // presentable message + structured classification (kind/status/retryable)
    if (asJson) {
      outJson({ type: "error", message: userMessage(e), error_info: classify(e) });
    }
    process.stderr.write(`error: ${userMessage(e)}\n`);
    return 1;
  } finally {
    process.removeListener("SIGINT", onSigint);
  }

  if (!asJson) {
    process.stdout.write(final + "\n");
    if (truncated) {
      process.stderr.write("warning: stopped at the tool-iteration limit, not a natural completion\n");
    }
  }
  if (values["output-last-message"]) {
    try {
      fs.writeFileSync(values["output-last-message"], final, "utf8");
    } catch (e) {
      process.stderr.write(`error writing --output-last-message: ${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    }
  }
  // Distinct from 0 so CI scripts can tell "the agent gave up on the round
  // budget" apart from "the task actually finished".
  return truncated ? 3 : 0;
}
