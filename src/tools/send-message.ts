/**
 * send_message: continue a previously spawned agent with its full transcript
 * (Claude Code SendMessage / continue-vs-spawn pattern).
 */

import { continueAgent } from "../agents/run.js";
import { listAgentSessions } from "../agents/sessions.js";
import { ArgumentError } from "./errors.js";
import { registerTool } from "./index.js";
import { registerToolMeta } from "./orchestration.js";

export async function sendMessage(to: string, message: string, summary?: string): Promise<string> {
  const id = to.trim();
  if (!id) return "Error: 'to' must be an agent-id from a prior agent result or task-notification.";
  const brief = summary?.trim() ? `[Continue: ${summary.trim()}]\n\n` : "";
  return continueAgent(id, `${brief}${message}`);
}

export function listAgentsTool(): string {
  const sessions = listAgentSessions();
  if (sessions.length === 0) {
    return "No continuable agents in this process. Spawn with the agent tool first.";
  }
  return (
    "Continuable agents:\n" +
    sessions
      .map(
        (s) =>
          `- ${s.id}  type=${s.agentType}  status=${s.status}  title=${JSON.stringify(s.title)}`,
      )
      .join("\n")
  );
}

registerTool("send_message", (a) => {
  const to = a["to"];
  const message = a["message"];
  if (typeof to !== "string") throw new ArgumentError("missing required argument: 'to'");
  if (typeof message !== "string") throw new ArgumentError("missing required argument: 'message'");
  return sendMessage(to, message, typeof a["summary"] === "string" ? a["summary"] : undefined);
});

registerTool("list_agents", () => listAgentsTool());

registerToolMeta({ name: "send_message", isConcurrencySafe: false, isReadOnly: true });
registerToolMeta({ name: "list_agents", isConcurrencySafe: true, isReadOnly: true });
