/**
 * Terminal renderer over Agent.runEvents (port of Agent.run, agent.py:629-683).
 *
 * Python uses rich (Live/Markdown/Status at 10fps). Here, without TUI
 * dependencies, the same visual protocol is reproduced with plain ANSI codes and
 * a homegrown spinner (section 4.6 of MIGRATION_SPEC, low priority): a
 * "thinking..." spinner, incremental markdown (streamed straight from the
 * tokens), a dim "-> tool(args)" line with the ~120-char summary below it (red
 * for failures via isFailureResult), a todos panel, and the "running..." spinner
 * while a tool runs.
 *
 * No global state: each turn creates its own local render state.
 */

import { Agent, isFailureResult, resultSummary } from "./agent.js";
import { render as renderTodos } from "./tools/todo.js";
import type { ServerEvent, TodoItem } from "./types.js";

// --- ANSI codes (no picocolors; raw strings to avoid pulling a dependency) --
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
// The agent's voice: bright blue, so the streamed answer is visually distinct
// from the user's own lines (which sit after the cyan "❯" prompt). TTY only.
const AGENT = "\x1b[94m";

function dim(text: string): string {
  return `${DIM}${text}${RESET}`;
}

function dimRed(text: string): string {
  return `${DIM}${RED}${text}${RESET}`;
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

/**
 * Runs a turn rendering the events in the terminal and returns the final text.
 * `out` is injectable (default process.stdout) for tests/surfaces.
 */
export async function runTurn(
  agent: Agent,
  userInput: string,
  out: NodeJS.WriteStream = process.stdout,
): Promise<string> {
  const state: RenderState = { spinner: null, streaming: false };

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
    stopVisuals();
    state.spinner = new Spinner(label, out);
    state.spinner.start();
  };

  const emit = (ev: ServerEvent): void => {
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
        stopVisuals();
        out.write(`${dim(`→ ${ev.name}(${ev.args.slice(0, 100)})`)}\n`);
        // spinner while the tool runs (bash, grep etc. can take a while)
        startSpinner("running...");
        break;
      }
      case "tool_end": {
        stopVisuals(); // stops the "running..." before printing the summary
        const summary = resultSummary(ev.result ?? "");
        if (summary) {
          const styled = isFailureResult(summary) ? dimRed(summary) : dim(summary);
          out.write(`  ${styled}\n`);
        }
        startSpinner("thinking...");
        break;
      }
      case "todos": {
        stopVisuals();
        out.write(renderTodosPanel(ev.todos));
        break;
      }
      case "status": {
        stopVisuals();
        out.write(`${dim(ev.text)}\n`);
        startSpinner("thinking...");
        break;
      }
      case "agents_start": {
        stopVisuals();
        const labels = ev.agents.map((a) => a.title).join(", ");
        out.write(`${dim(`▸ parallel agents: ${labels}`)}\n`);
        startSpinner("agents running...");
        break;
      }
      case "agent_update": {
        stopVisuals();
        const detail = ev.detail ? ` — ${ev.detail}` : "";
        const mark =
          ev.status === "done" ? "✓" : ev.status === "error" ? "✗" : "…";
        out.write(`${dim(`  ${mark} ${ev.id}${detail}`)}\n`);
        if (ev.status === "running") startSpinner("agents running...");
        break;
      }
      case "agents_end": {
        stopVisuals();
        out.write(`${dim("▸ agents finished")}\n`);
        startSpinner("thinking...");
        break;
      }
      case "done": {
        stopVisuals();
        break;
      }
      default:
        // permission_request/question_request/usage/error do not render here
        break;
    }
  };

  startSpinner("thinking...");
  try {
    return await agent.runEvents(userInput, emit);
  } finally {
    stopVisuals();
  }
}

/** Todos panel with a dim frame (equivalent of rich's Panel(todo.render())). */
function renderTodosPanel(todos: TodoItem[]): string {
  const body = renderTodos(todos);
  const lines = body.split("\n");
  const width = Math.max(6, ...lines.map((l) => l.length));
  const top = dim(`┌─ tasks ${"─".repeat(Math.max(0, width - 6))}┐`);
  const bottom = dim(`└${"─".repeat(width + 2)}┘`);
  const mid = lines.map((l) => `${dim("│")} ${l.padEnd(width)} ${dim("│")}`).join("\n");
  return `${top}\n${mid}\n${bottom}\n`;
}
