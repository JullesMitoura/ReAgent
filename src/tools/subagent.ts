/**
 * Compat `explore` tool — thin wrapper around agent(subagent_type=explore).
 */

import { config } from "../config.js";
import { runAgent } from "../agents/run.js";
import { getLogger } from "../logs.js";
import { ArgumentError } from "./errors.js";
import { registerTool } from "./index.js";

// Re-export for parallel.ts and external callers.
export { assistantMessage } from "../agent/tool-loop.js";

const log = getLogger("subagent");

/** Runs the read-only explore sub-agent and returns the final summary (text). */
export async function explore(description: string, prompt: string): Promise<string> {
  if (!config.enableSubagent) {
    return 'Error: the explore tool is disabled (set "subagent": true in .reagent/config.json to enable)';
  }

  log.info("subagent explore: %s", (description || "").slice(0, 80));
  return runAgent({
    agentType: "explore",
    prompt,
    title: description || "explore",
  });
}

registerTool("explore", (a) => {
  const description = a["description"];
  const prompt = a["prompt"];
  if (typeof prompt !== "string") throw new ArgumentError("missing required argument: 'prompt'");
  return explore(typeof description === "string" ? description : "", prompt);
});
