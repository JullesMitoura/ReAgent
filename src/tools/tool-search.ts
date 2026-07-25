/**
 * `tool_search` tool: discover and activate deferred tools for the current turn
 * (Claude Code ToolSearch pattern). When config.enableDeferredTools is on, niche
 * tools are hidden from the schema until unlocked here, keeping the default tool
 * surface small. Unlocking mutates the turn's `enabledDeferred` set; activeSchemas()
 * then offers the matching schema on the next round.
 */

import { config } from "../config.js";
import { getLogger } from "../logs.js";
import { currentTurn } from "../turn-context.js";
import { ArgumentError } from "./errors.js";
import { registerTool } from "./index.js";
import { registerToolMeta } from "./orchestration.js";

const log = getLogger("tool-search");

/** Deferred tools and the keywords that surface them. */
const DEFERRED_CATALOG: Record<string, string[]> = {
  webfetch: ["web", "fetch", "url", "http", "download", "page", "internet"],
  exec_command: ["exec", "shell", "session", "server", "repl", "watch", "long", "pty", "process"],
  write_stdin: ["stdin", "input", "session", "interact", "repl", "type"],
  remember: ["remember", "memory", "preference", "profile", "durable", "user"],
  workflow: ["workflow", "orchestrate", "pipeline", "multi-agent", "fan out", "fan-out"],
};

export function toolSearch(query: string): string {
  const turn = currentTurn();
  if (!turn) return "Error: tool_search must run inside a turn";
  if (!config.enableDeferredTools) {
    return "All tools are already active (deferred-tool mode is off); no search needed.";
  }
  const q = query.toLowerCase();
  const matched: string[] = [];
  for (const [name, keywords] of Object.entries(DEFERRED_CATALOG)) {
    if (name.toLowerCase().includes(q) || keywords.some((k) => q.includes(k))) {
      turn.enabledDeferred.add(name);
      matched.push(name);
    }
  }
  if (matched.length === 0) {
    const available = Object.keys(DEFERRED_CATALOG).join(", ");
    return `No deferred tool matched "${query}". Available deferred tools: ${available}.`;
  }
  log.info("tool_search unlocked: %s", matched.join(", "));
  return (
    `Activated for this turn: ${matched.join(", ")}. ` +
    "Their schemas are now available; call them on your next step."
  );
}

registerTool("tool_search", (a) => {
  const query = a["query"];
  if (typeof query !== "string") throw new ArgumentError("missing required argument: 'query'");
  return toolSearch(query);
});

registerToolMeta({ name: "tool_search", isConcurrencySafe: true, isReadOnly: true });
