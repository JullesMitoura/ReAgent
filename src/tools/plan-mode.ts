/**
 * `exit_plan_mode` tool: present the finished plan for approval and leave plan mode
 * so implementation can begin (Claude Code ExitPlanMode pattern).
 *
 * Plan mode keeps the tool surface read-only; this is the single transition out.
 * It flips the process permission mode back to "default" and echoes the plan into
 * the transcript. Asking "should I proceed?" belongs here, never in the question tool.
 */

import { config } from "../config.js";
import { getLogger } from "../logs.js";
import { currentTurn } from "../turn-context.js";
import { ArgumentError } from "./errors.js";
import { registerTool } from "./index.js";
import { registerToolMeta } from "./orchestration.js";

const log = getLogger("plan-mode");

export function exitPlanMode(plan: string, summary?: string): string {
  if (config.permissionMode !== "plan") {
    return "Error: not in plan mode; nothing to exit. Proceed with the task directly.";
  }
  // Leave the read-only plan surface so writes/bash become available for approval.
  config.permissionMode = "default";
  const turn = currentTurn();
  turn?.emit?.({ type: "status", text: "Plan ready; exiting plan mode" });
  log.info("exit_plan_mode: %s", (summary || plan).slice(0, 80));
  const head = summary ? `${summary}\n\n` : "";
  return (
    `${head}${plan}\n\n` +
    "Plan mode exited. Implement the plan now, keeping to its scope; " +
    "request approval for file writes and shell commands as usual."
  );
}

registerTool("exit_plan_mode", (a) => {
  const plan = a["plan"];
  if (typeof plan !== "string") throw new ArgumentError("missing required argument: 'plan'");
  return exitPlanMode(plan, typeof a["summary"] === "string" ? a["summary"] : undefined);
});

registerToolMeta({ name: "exit_plan_mode", isConcurrencySafe: false, isReadOnly: true });
