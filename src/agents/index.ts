/**
 * Agent registry + tool registration (plan, agent).
 * explore / parallel_agents remain in tools/subagent and tools/parallel for compat.
 */

import { config } from "../config.js";
import { buildSystemPrompt } from "../system-prompt.js";
import { ArgumentError } from "../tools/errors.js";
import { registerTool } from "../tools/index.js";
import { registerToolMeta } from "../tools/orchestration.js";
import { allAgents, getAgent, runAgent } from "./run.js";

export type { AgentDefinition, RunAgentOptions } from "./types.js";
export { allAgents, continueAgent, getAgent, runAgent } from "./run.js";
export { builtinAgents } from "./builtin.js";
export { loadDiskAgents } from "./load.js";
export { clearAgentSessions, getAgentSession, listAgentSessions } from "./sessions.js";
export { createAgentWorktree } from "./worktree.js";

/** Plan tool: read-only planning sub-agent. */
export async function planTool(description: string, prompt: string): Promise<string> {
  if (!config.enableSubagent) {
    return 'Error: plan/explore agents are disabled (set "subagent": true in .reagent/config.json)';
  }
  return runAgent({
    agentType: "plan",
    prompt,
    title: description || "plan",
  });
}

/** Generic agent tool: explore | plan | general-purpose | coordinator-worker (+ disk). */
export async function agentTool(
  subagentType: string,
  description: string,
  prompt: string,
  opts: { fork?: boolean; background?: boolean } = {},
): Promise<string> {
  if (!config.enableSubagent) {
    return 'Error: the agent tool is disabled (set "subagent": true in .reagent/config.json)';
  }
  const def = getAgent(subagentType);
  if (!def) {
    const known = allAgents().map((a) => a.agentType);
    return `Error: unknown subagent_type '${subagentType}'. Known: ${known.join(", ")}`;
  }
  if (subagentType === "worker") {
    return "Error: use parallel_agents to spawn workers, not the agent tool";
  }
  // Enforce declared capabilities: a type that does not support fork/background is
  // not launched that way (silently downgraded, with a one-line note prepended).
  const notes: string[] = [];
  let fork = Boolean(opts.fork);
  let background = Boolean(opts.background);
  if (fork && !def.supportsFork) {
    fork = false;
    notes.push(`(note: '${subagentType}' does not support fork; ran fresh instead)`);
  }
  if (background && !def.supportsBackground) {
    background = false;
    notes.push(`(note: '${subagentType}' does not support background; ran in the foreground)`);
  }
  const report = await runAgent({
    agentType: subagentType,
    prompt,
    title: description || subagentType,
    fork,
    background,
    parentSystemPrompt: fork ? buildSystemPrompt() : undefined,
  });
  return notes.length ? `${notes.join(" ")}\n${report}` : report;
}

registerTool("plan", (a) => {
  const prompt = a["prompt"];
  if (typeof prompt !== "string") throw new ArgumentError("missing required argument: 'prompt'");
  return planTool(typeof a["description"] === "string" ? a["description"] : "", prompt);
});

registerTool("agent", (a) => {
  const subagentType = a["subagent_type"];
  const prompt = a["prompt"];
  if (typeof subagentType !== "string") {
    throw new ArgumentError("missing required argument: 'subagent_type'");
  }
  if (typeof prompt !== "string") throw new ArgumentError("missing required argument: 'prompt'");
  return agentTool(
    subagentType,
    typeof a["description"] === "string" ? a["description"] : "",
    prompt,
    {
      fork: Boolean(a["fork"]),
      background: Boolean(a["background"]),
    },
  );
});

registerToolMeta({ name: "plan", isConcurrencySafe: true, isReadOnly: true });
registerToolMeta({ name: "agent", isConcurrencySafe: true });
