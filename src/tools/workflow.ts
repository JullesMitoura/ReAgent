/**
 * `workflow` tool: opt-in deterministic multi-agent orchestration.
 *
 *  - mode=pipeline: steps run sequentially; each later step is given the prior
 *    steps' reports, so it can build on them.
 *  - mode=parallel: steps run concurrently, bounded by config.maxAgentConcurrency
 *    (a rolling window, not an unbounded Promise.all).
 *
 * Each step is a fresh sub-agent (agent_type + self-contained prompt). Disabled by
 * default (config.enableWorkflow); only offered when the user opts into structured
 * fan-out. Intentionally minimal workflow orchestration.
 */

import { allAgents, runAgent } from "../agents/run.js";
import { config } from "../config.js";
import { mapLimit } from "../lib/pool.js";
import { getLogger } from "../logs.js";
import { registerTool } from "./index.js";
import { registerToolMeta } from "./orchestration.js";
import { structuredStatusIsError } from "./structured-output.js";

const log = getLogger("workflow");

interface Step {
  agent_type: string;
  prompt: string;
  title?: string;
}

function parseSteps(raw: unknown): Step[] | string {
  if (!Array.isArray(raw)) return "Error: steps must be an array of {agent_type, prompt} objects";
  const steps: Step[] = [];
  for (const s of raw) {
    if (typeof s !== "object" || s === null) return "Error: each step must be an object";
    const o = s as Record<string, unknown>;
    const agentType = String(o["agent_type"] ?? "").trim();
    const prompt = String(o["prompt"] ?? "").trim();
    if (!agentType || !prompt) return "Error: each step needs a non-empty agent_type and prompt";
    steps.push({
      agent_type: agentType,
      prompt,
      title: typeof o["title"] === "string" ? o["title"] : undefined,
    });
  }
  if (steps.length < 1) return "Error: a workflow needs at least one step";
  return steps;
}

function section(title: string, status: string, report: string): string {
  return `### ${title} [${status}]\n${report}`;
}

async function runStep(step: Step, index: number, context: string): Promise<[string, string]> {
  const title = step.title || `${step.agent_type} #${index + 1}`;
  const prompt = context
    ? `${step.prompt}\n\n--- Prior workflow results (context) ---\n${context}`
    : step.prompt;
  try {
    const report = await runAgent({ agentType: step.agent_type, prompt, title });
    const status =
      report.startsWith("(cancelled") || structuredStatusIsError(report) ? "error" : "done";
    return [status, report];
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return ["error", `Error: ${msg}`];
  }
}

export async function workflow(mode: unknown, rawSteps: unknown): Promise<string> {
  if (!config.enableWorkflow) {
    return 'Error: the workflow tool is disabled (set "workflow": true in .reagent/config.json)';
  }
  if (mode !== "pipeline" && mode !== "parallel") {
    return "Error: mode must be 'pipeline' or 'parallel'";
  }
  const steps = parseSteps(rawSteps);
  if (typeof steps === "string") return steps;

  const known = new Set(allAgents().map((a) => a.agentType));
  const unknown = steps.find((s) => !known.has(s.agent_type));
  if (unknown) {
    return `Error: unknown agent_type '${unknown.agent_type}'. Known: ${[...known].join(", ")}`;
  }

  log.info("workflow %s: %d steps", mode, steps.length);
  const sections: string[] = [];

  if (mode === "parallel") {
    const results = await mapLimit(steps, config.maxAgentConcurrency, (s, i) => runStep(s, i, ""));
    steps.forEach((s, i) => {
      const [status, report] = results[i]!;
      sections.push(section(s.title || `${s.agent_type} #${i + 1}`, status, report));
    });
  } else {
    // pipeline: sequential, each step sees the accumulated prior reports.
    let context = "";
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i]!;
      const [status, report] = await runStep(s, i, context);
      const label = s.title || `${s.agent_type} #${i + 1}`;
      sections.push(section(label, status, report));
      context += `${context ? "\n\n" : ""}### ${label}\n${report}`;
    }
  }

  return `Workflow (${mode}) finished: ${steps.length} steps.\n\n${sections.join("\n\n")}`;
}

registerTool("workflow", (a) => workflow(a["mode"], a["steps"]));

registerToolMeta({ name: "workflow", isConcurrencySafe: false });
