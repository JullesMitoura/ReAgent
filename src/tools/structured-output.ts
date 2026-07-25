/**
 * `structured_output` tool: a sub-agent's machine-readable final report
 * (Claude Code SyntheticOutputTool pattern).
 *
 * Calling it ENDS the sub-agent's run: the tool-loop treats it as terminal and
 * returns its formatted payload as the report. This gives the parent a predictable
 * first line ("[status] summary") plus an explicit files-changed list, instead of
 * having to parse a free-form final message. Offered only to reporting sub-agents
 * (worker / general-purpose / coordinator-worker), never to the main agent.
 */

import { registerTool } from "./index.js";
import { registerToolMeta } from "./orchestration.js";

export const STRUCTURED_OUTPUT_SCHEMA = {
  type: "function",
  function: {
    name: "structured_output",
    description:
      "Report your final result and END your run. Call this once, as your LAST action, " +
      "instead of a plain final message: pass a one-sentence summary the caller can relay, " +
      "a status, and the exact files you changed. Use status='blocked' or 'failed' if you " +
      "could not finish, with the reason in details.",
    parameters: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["done", "blocked", "failed"],
          description: "done = task complete; blocked = needs a decision/dependency; failed = error",
        },
        summary: {
          type: "string",
          description: "One sentence the caller can relay to the user",
        },
        files_changed: {
          type: "array",
          items: { type: "string" },
          description: "Repo-relative paths you created, edited, or deleted (omit if none)",
        },
        details: {
          type: "string",
          description: "Optional specifics: what you did or found, with file:line references",
        },
      },
      required: ["status", "summary"],
    },
  },
};

type Status = "done" | "blocked" | "failed";

function normalizeStatus(raw: unknown): Status {
  const s = String(raw ?? "").toLowerCase().trim();
  return s === "blocked" || s === "failed" ? s : "done";
}

/** Formats the payload into the canonical report the parent reads. */
export function structuredOutput(args: Record<string, unknown>): string {
  const status = normalizeStatus(args["status"]);
  const summary = String(args["summary"] ?? "").trim() || "(no summary)";
  const filesRaw = args["files_changed"];
  const files = Array.isArray(filesRaw)
    ? filesRaw.map((f) => String(f).trim()).filter(Boolean)
    : [];
  const details = String(args["details"] ?? "").trim();

  let out = `[${status}] ${summary}`;
  if (files.length) out += `\nfiles: ${files.join(", ")}`;
  if (details) out += `\n\n${details}`;
  return out;
}

/** True when a report begins with a failed/blocked structured-output marker. */
export function structuredStatusIsError(report: string): boolean {
  return /^\[(failed|blocked)\]/i.test(report.trimStart());
}

registerTool("structured_output", (a) => structuredOutput(a));
registerToolMeta({ name: "structured_output", isConcurrencySafe: false });
