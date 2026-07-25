/**
 * Terminal renderer over Agent.runEvents (port of Agent.run, agent.py:629-683).
 *
 * Redesigned for a Claude-Code-style experience: raw tool names/JSON never
 * appear at the default verbosity. Instead each tool call gets a friendly,
 * present-continuous one-liner (tool-labels.ts), the task list shows a
 * completion percentage, and the turn ends with a compact, honest summary
 * (files touched, commands run, sub-agents used, errors, elapsed time —
 * derived only from signals this file can actually observe, never guessed).
 *
 * config.verbosity controls how much of this shows:
 *   - quiet:   spinner + streamed answer + errors only
 *   - normal:  + friendly tool one-liners, task list, final summary
 *   - verbose: + a technical line (tool name + summarized args) per call
 *   - debug:   raw tool calls/results, unfiltered
 *
 * Python used rich (Live/Markdown/Status at 10fps). Here, without TUI
 * dependencies, the same visual protocol is reproduced with plain ANSI codes
 * and a homegrown spinner (section 4.6 of MIGRATION_SPEC, low priority).
 *
 * No global state: each turn creates its own local render state.
 */

import { Agent, isFailureResult, resultSummary, TurnCancelled } from "./agent.js";
import { STATUS_THINKING } from "./agent/status.js";
import type { ChangeTracker } from "./changes.js";
import { toolLabel, toolTechnicalDetail } from "./cli/tool-labels.js";
import { config } from "./config.js";
import { render as renderTodos } from "./tools/todo.js";
import { headTail } from "./tools/index.js";
import { currentTurn } from "./turn-context.js";
import type { ServerEvent, TodoItem } from "./types.js";

// --- ANSI codes (no picocolors; raw strings to avoid pulling a dependency) --
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
// The agent's voice: bright blue, so the streamed answer is visually distinct
// from the user's own lines (which sit after the cyan "❯" prompt). TTY only.
const AGENT = "\x1b[94m";

function dim(text: string): string {
  return `${DIM}${text}${RESET}`;
}

function dimRed(text: string): string {
  return `${DIM}${RED}${text}${RESET}`;
}

function yellow(text: string): string {
  return `${YELLOW}${text}${RESET}`;
}

/** Minimalist spinner: rewrites the current line with \r on each frame. */
class Spinner {
  private static readonly FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  private timer: NodeJS.Timeout | null = null;
  private i = 0;

  constructor(
    private readonly label: string,
    private readonly out: NodeJS.WriteStream,
  ) {}

  start(): void {
    if (this.timer !== null) return;
    // only animates in a TTY; outside it (pipe/test) it stays silent
    if (!this.out.isTTY) return;
    this.timer = setInterval(() => {
      const frame = Spinner.FRAMES[this.i % Spinner.FRAMES.length]!;
      this.i += 1;
      this.out.write(`\r${DIM}${frame} ${this.label}${RESET}`);
    }, 100);
    // does not keep the event loop open just for the spinner
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.out.isTTY) {
      // clears the spinner line before printing the next content
      this.out.write(`\r${" ".repeat(this.label.length + 4)}\r`);
    }
  }
}

interface RenderState {
  spinner: Spinner | null;
  streaming: boolean;
}

/** Per-turn counters behind the end-of-turn summary; every field is a real, observed signal. */
interface TurnStats {
  startedAt: number;
  toolCalls: number;
  commandsRun: number;
  subAgentsLaunched: number;
  toolErrors: number;
  /** id -> tool name, so tool_end (which only carries the id) can look up context. */
  pending: Map<string, { name: string; startedAt: number }>;
}

function newTurnStats(): TurnStats {
  return {
    startedAt: Date.now(),
    toolCalls: 0,
    commandsRun: 0,
    subAgentsLaunched: 0,
    toolErrors: 0,
    pending: new Map(),
  };
}

function formatElapsed(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s - m * 60);
  return `${m}m ${String(rem).padStart(2, "0")}s`;
}

/** Compact, honest one-line summary; "" when there is nothing worth reporting. */
export function buildFinalSummary(
  stats: TurnStats,
  changesSummary: { created: string[]; modified: string[]; deleted: string[] } | null,
): string {
  const parts: string[] = [];
  if (changesSummary) {
    const bits: string[] = [];
    if (changesSummary.created.length) bits.push(`${changesSummary.created.length} created`);
    if (changesSummary.modified.length) bits.push(`${changesSummary.modified.length} modified`);
    if (changesSummary.deleted.length) bits.push(`${changesSummary.deleted.length} deleted`);
    if (bits.length) parts.push(`files: ${bits.join(", ")}`);
  }
  if (stats.commandsRun) parts.push(`commands: ${stats.commandsRun}`);
  if (stats.subAgentsLaunched) parts.push(`sub-agents: ${stats.subAgentsLaunched}`);
  if (stats.toolErrors) parts.push(`errors: ${stats.toolErrors}`);
  if (!parts.length) return "";
  return `${parts.join("  ·  ")}  ·  ${formatElapsed(Date.now() - stats.startedAt)}`;
}

const AGENT_TOOL_NAMES = new Set(["agent", "explore", "plan"]);
const COMMAND_TOOL_NAMES = new Set(["bash", "exec_command"]);

/**
 * Runs a turn rendering the events in the terminal and returns the final text.
 * `out` is injectable (default process.stdout) for tests/surfaces. `changes`
 * (when given) feeds the end-of-turn files-touched summary; without it that
 * line is simply omitted (never guessed).
 */
export async function runTurn(
  agent: Agent,
  userInput: string,
  out: NodeJS.WriteStream = process.stdout,
  changes?: ChangeTracker,
): Promise<string> {
  const verbosity = config.verbosity;
  const chatty = verbosity !== "quiet";
  const state: RenderState = { spinner: null, streaming: false };
  const stats = newTurnStats();
  let lastSpinnerLabel = "thinking...";

  const stopVisuals = (): void => {
    if (state.spinner !== null) {
      state.spinner.stop();
      state.spinner = null;
    }
    if (state.streaming) {
      if (out.isTTY) out.write(RESET);
      out.write("\n");
      state.streaming = false;
    }
  };

  const startSpinner = (label: string): void => {
    lastSpinnerLabel = label;
    stopVisuals();
    state.spinner = new Spinner(label, out);
    state.spinner.start();
  };

  // A permission/question prompt (permissions.ts, tools/question.ts) blocks
  // mid-tool-call waiting on stdin; without pausing first, the spinner's own
  // setInterval kept writing "\r<frame> running..." every 100ms right on top
  // of the prompt's own text, visibly corrupting both. currentTurn() here is
  // the SAME TurnContext object repl.ts created (runTurn always runs inside
  // its runWithTurn), so mutating it reaches every nested call too.
  const turnForHooks = currentTurn();
  const priorBeforePrompt = turnForHooks?.beforePrompt;
  const priorAfterPrompt = turnForHooks?.afterPrompt;
  if (turnForHooks) {
    turnForHooks.beforePrompt = () => stopVisuals();
    turnForHooks.afterPrompt = () => startSpinner(lastSpinnerLabel);
  }

  const emit = (ev: ServerEvent): void => {
    // Cooperative cancellation (same pattern as the server's RunningTurn):
    // once Ctrl+C sets the turn's cancel flag, stop rendering further events
    // and unwind the agent loop instead of letting it run to completion
    // detached from the REPL that already moved on.
    if (currentTurn()?.cancel.set) throw new TurnCancelled();
    switch (ev.type) {
      case "token": {
        // first time: stops the spinner and starts printing the streamed text
        if (!state.streaming) {
          if (state.spinner !== null) {
            state.spinner.stop();
            state.spinner = null;
          }
          state.streaming = true;
          if (out.isTTY) out.write(AGENT); // open the agent color for the answer
        }
        out.write(ev.text);
        break;
      }
      case "tool_start": {
        stats.toolCalls += 1;
        stats.pending.set(ev.id, { name: ev.name, startedAt: Date.now() });
        if (COMMAND_TOOL_NAMES.has(ev.name)) stats.commandsRun += 1;
        if (AGENT_TOOL_NAMES.has(ev.name)) stats.subAgentsLaunched += 1;
        if (chatty) {
          stopVisuals();
          if (verbosity === "debug") {
            out.write(`${dim(`→ ${toolTechnicalDetail(ev.name, ev.args, true)}`)}\n`);
          } else {
            out.write(`${dim(`→ ${toolLabel(ev.name, ev.args)}`)}\n`);
            if (verbosity === "verbose") {
              out.write(`${dim(`  ${toolTechnicalDetail(ev.name, ev.args, false)}`)}\n`);
            }
          }
        }
        // spinner while the tool runs (bash, grep etc. can take a while)
        startSpinner("running...");
        break;
      }
      case "tool_end": {
        const info = stats.pending.get(ev.id);
        stats.pending.delete(ev.id);
        const failed = isFailureResult(resultSummary(ev.result ?? ""));
        if (failed) stats.toolErrors += 1;
        if (chatty) {
          stopVisuals(); // stops the "running..." before printing the summary
          if (verbosity === "debug") {
            const full = headTail(ev.result ?? "", 4000);
            if (full) out.write(`  ${failed ? dimRed(full) : dim(full)}\n`);
          } else {
            const summary = resultSummary(ev.result ?? "");
            if (summary) out.write(`  ${failed ? dimRed(summary) : dim(summary)}\n`);
          }
          if (verbosity !== "normal" && info) {
            const elapsed = formatElapsed(Date.now() - info.startedAt);
            out.write(`${dim(`  (${elapsed})`)}\n`);
          }
        }
        startSpinner("thinking...");
        break;
      }
      case "todos": {
        if (chatty) {
          stopVisuals();
          out.write(renderTodosPanel(ev.todos));
        }
        break;
      }
      case "status": {
        // STATUS_THINKING is a generic "still working" filler re-emitted every
        // round a turn keeps going (see agent/query.ts); printing it as a
        // permanent line stacked a new stuck "Thinking…" line above the spinner
        // on every round (the spinner's \r-redraw only clears its own line,
        // never ones already scrolled past). Every other status text is a real
        // state change worth keeping on screen.
        if (chatty && ev.text !== STATUS_THINKING) {
          stopVisuals();
          out.write(`${dim(ev.text)}\n`);
        }
        startSpinner("thinking...");
        break;
      }
      case "agents_start": {
        stats.subAgentsLaunched += ev.agents.length;
        if (chatty) {
          stopVisuals();
          const labels = ev.agents.map((a) => a.title).join(", ");
          out.write(`${dim(`▸ parallel agents: ${labels}`)}\n`);
        }
        startSpinner("agents running...");
        break;
      }
      case "agent_update": {
        if (chatty) {
          stopVisuals();
          const detail = ev.detail ? ` — ${ev.detail}` : "";
          const mark = ev.status === "done" ? "✓" : ev.status === "error" ? "✗" : "…";
          out.write(`${dim(`  ${mark} ${ev.id}${detail}`)}\n`);
        }
        if (ev.status === "error") stats.toolErrors += 1;
        if (ev.status === "running") startSpinner("agents running...");
        break;
      }
      case "agents_end": {
        if (chatty) {
          stopVisuals();
          out.write(`${dim("▸ agents finished")}\n`);
        }
        startSpinner("thinking...");
        break;
      }
      case "usage": {
        // Compact context footprint in normal+ modes (helps users know when
        // to /compact). Quiet stays silent; debug already has richer logs.
        if (verbosity === "normal" || verbosity === "verbose") {
          const window = ev.context_window ?? 0;
          const used = ev.last_prompt_tokens ?? 0;
          if (window > 0 && used > 0) {
            const pct = Math.min(100, Math.round((100 * used) / window));
            const left = Math.max(0, 100 - pct);
            // Only refresh the spinner label — avoid scrolling a new line every
            // round; the final summary already reports elapsed work.
            if (state.spinner !== null) {
              state.spinner.stop();
              state.spinner = null;
            }
            startSpinner(`thinking… context ${used}/${window} (${left}% left)`);
          }
        }
        break;
      }
      case "done": {
        stopVisuals();
        if (ev.truncated) {
          out.write(
            `${yellow("⚠ Stopped early: reached the tool-iteration limit.")} ` +
              `${dim("(raise max_iterations, or ask me to continue)")}\n`,
          );
        }
        if (verbosity !== "quiet") {
          const changesSummary = changes ? changes.summary() : null;
          const summary = buildFinalSummary(stats, changesSummary);
          if (summary) out.write(dim(summary) + "\n");
        } else if (stats.toolErrors > 0) {
          out.write(dimRed(`${stats.toolErrors} tool call(s) failed this turn`) + "\n");
        }
        break;
      }
      default:
        // permission_request/question_request/error do not render here
        break;
    }
  };

  startSpinner("thinking...");
  try {
    return await agent.runEvents(userInput, emit);
  } finally {
    stopVisuals();
    if (turnForHooks) {
      turnForHooks.beforePrompt = priorBeforePrompt;
      turnForHooks.afterPrompt = priorAfterPrompt;
    }
  }
}

/** Todos panel with a dim frame and a completion percentage in its header. */
function renderTodosPanel(todos: TodoItem[]): string {
  const body = renderTodos(todos);
  const lines = body.split("\n");
  const total = todos.length;
  const done = todos.filter((t) => t.status === "completed").length;
  const label = total ? `tasks ${done}/${total} (${Math.round((100 * done) / total)}%)` : "tasks";
  const width = Math.max(label.length + 2, ...lines.map((l) => l.length));
  const top = dim(`┌─ ${label} ${"─".repeat(Math.max(0, width - 1 - label.length))}┐`);
  const bottom = dim(`└${"─".repeat(width + 2)}┘`);
  const mid = lines.map((l) => `${dim("│")} ${l.padEnd(width)} ${dim("│")}`).join("\n");
  return `${top}\n${mid}\n${bottom}\n`;
}
