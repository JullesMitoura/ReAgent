/**
 * Port of src/tools/parallel.py: the `parallel_agents` tool.
 * Workers run via agents/run (shared tool-loop) with the worker definition.
 */

import { config } from "../config.js";
import { mapLimit } from "../lib/pool.js";
import { getLogger } from "../logs.js";
import { WORKER_WHEN_TO_USE } from "../prompts/agents/worker.js";
import { WRITING_SUBAGENT_PROMPTS } from "../prompts/tools/agent-briefing.js";
import { currentTurn } from "../turn-context.js";
import type { AgentBranchStatus, ServerEvent } from "../types.js";
import { runAgent } from "../agents/run.js";
import { registerTool } from "./index.js";
import { structuredStatusIsError } from "./structured-output.js";

const log = getLogger("parallel");

void WORKER_WHEN_TO_USE;
void WRITING_SUBAGENT_PROMPTS;
// Agent-launched reminders are injected by query/tool-loop via reminders/inject.

function safeEmit(ev: ServerEvent): void {
  const ctx = currentTurn();
  if (!ctx) return;
  if (ctx.cancel.set) return;
  const fn = ctx.emit;
  if (!fn) return;
  try {
    fn(ev);
  } catch {
    ctx.cancel.set = true;
  }
}

function callLabel(name: string, argumentsJson: string): string {
  let args: Record<string, unknown>;
  try {
    args = (JSON.parse(argumentsJson || "{}") ?? {}) as Record<string, unknown>;
  } catch {
    args = {};
  }
  let target = String(args["path"] || args["pattern"] || args["command"] || "");
  target = target.split("\n")[0]!;
  if (target.length > 40) target = target.slice(0, 40) + "…";
  return `${name} ${target}`.trim();
}

function firstLine(text: string, limit = 100): string {
  for (const raw of text.split("\n")) {
    const stripped = raw.trim();
    if (stripped) return stripped.slice(0, limit);
  }
  return "";
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A denied (or blocked) permission on a tool result: the worker "failed". */
function looksDenied(result: string): boolean {
  const r = result.trimStart();
  return /^user denied/i.test(r) || r.startsWith("(dangerous command blocked");
}

async function runWorker(
  branchId: string,
  title: string,
  prompt: string,
): Promise<[AgentBranchStatus, string]> {
  try {
    let denied = false;
    const report = await runAgent({
      agentType: "worker",
      prompt,
      title,
      sessionFooter: false,
      onToolStart: (name, args) => {
        safeEmit({
          type: "agent_update",
          id: branchId,
          status: "running",
          detail: callLabel(name, args),
        });
      },
      // A denied action marks the whole branch as failed (red), even though the
      // worker keeps going and returns a report.
      onToolEnd: (_name, result) => {
        if (looksDenied(result)) denied = true;
      },
    });
    if (report.startsWith("(cancelled")) return ["error", report];
    if (denied) return ["error", report];
    // The worker itself reported blocked/failed via structured_output.
    if (structuredStatusIsError(report)) return ["error", report];
    return ["done", report];
  } catch (e) {
    const typ = e instanceof Error ? e.constructor.name : typeof e;
    const msg = e instanceof Error ? e.message : String(e);
    return ["error", `${typ}: ${msg}`];
  }
}

/** Dispatches the workers in parallel and returns the reports to the main agent. */
export async function parallelAgents(tasks: unknown): Promise<string> {
  if (!config.enableParallel) {
    return 'Error: the parallel_agents tool is disabled (set "parallel_agents": true in .reagent/config.json)';
  }
  if (!Array.isArray(tasks) || !tasks.every((t) => isPlainObject(t))) {
    return "Error: tasks must be a list of {title, prompt} objects";
  }
  const filtered = (tasks as Record<string, unknown>[]).filter(
    (t) => String(t["title"] ?? "").trim() && String(t["prompt"] ?? "").trim(),
  );
  if (filtered.length < 2) {
    return "Error: parallel_agents needs at least 2 independent tasks; do a single task yourself";
  }
  if (filtered.length > config.parallelMaxAgents) {
    return `Error: at most ${config.parallelMaxAgents} parallel tasks (got ${filtered.length}); merge or drop some`;
  }

  const branches = filtered.map((t, i) => ({
    id: `a${i + 1}`,
    title: String(t["title"]).trim().slice(0, 60),
  }));
  log.info(
    "parallel_agents: %d workers: %s",
    branches.length,
    branches.map((b) => b.title),
  );
  safeEmit({ type: "agents_start", agents: branches });

  const run = async (
    branch: { id: string; title: string },
    task: Record<string, unknown>,
  ): Promise<[AgentBranchStatus, string]> => {
    let status: AgentBranchStatus;
    let report: string;
    try {
      [status, report] = await runWorker(branch.id, branch.title, String(task["prompt"]));
    } catch (e) {
      const typ = e instanceof Error ? e.constructor.name : typeof e;
      const msg = e instanceof Error ? e.message : String(e);
      log.warning("worker %s failed: %s", branch.id, typ);
      status = "error";
      report = `${typ}: ${msg}`;
    }
    safeEmit({ type: "agent_update", id: branch.id, status, detail: firstLine(report) });
    return [status, report];
  };

  // Rolling window: at most maxAgentConcurrency workers stream at once, even when
  // the plan lists up to parallelMaxAgents tasks (bounds LLM streams + shells).
  const results = await mapLimit(branches, config.maxAgentConcurrency, (b, i) =>
    run(b, filtered[i]!),
  );

  safeEmit({ type: "agents_end" });

  const sections = branches.map((branch, i) => {
    const [status, report] = results[i]!;
    return `### ${branch.title} [${status}]\n${report}`;
  });
  const header = `All ${branches.length} parallel workers finished. Reports:\n\n`;
  return header + sections.join("\n\n");
}

registerTool("parallel_agents", (a) => parallelAgents(a["tasks"]));
