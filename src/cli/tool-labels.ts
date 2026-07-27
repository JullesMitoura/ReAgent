/**
 * Human-friendly, present-continuous descriptions of a tool call, for the
 * default ("normal") terminal verbosity — raw tool names
 * and JSON payloads never appear in the default experience (see
 * CLI_UX_REDESIGN's "Tool Calls" section). Verbose/Debug fall back to
 * toolTechnicalDetail for the parts of the audience that want the mechanics.
 *
 * `argsJson` may be truncated mid-stream (tool_start emits at most 200 chars
 * of the call's arguments so the UI can react before the call finishes
 * streaming — see agent/query.ts), so it is not always valid JSON. Every
 * lookup here degrades gracefully to a generic label instead of throwing.
 */

function parseArgs(argsJson: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(argsJson);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // truncated/invalid JSON: callers fall back to scavengeString below
  }
  return {};
}

/** Best-effort "key":"value" scavenger that survives a JSON string cut off mid-value. */
function scavengeString(argsJson: string, key: string): string | undefined {
  const m = new RegExp(`"${key}"\\s*:\\s*"([^"]*)`).exec(argsJson);
  return m?.[1];
}

function truncate(s: string, max = 64): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/** Reads a string field from parsed args, or scavenges it from raw (possibly truncated) JSON. */
function field(args: Record<string, unknown>, argsJson: string, key: string): string | undefined {
  const v = args[key];
  if (typeof v === "string") return v;
  return scavengeString(argsJson, key);
}

/** One friendly line describing what a tool call is doing, e.g. "Editing src/app.ts". */
export function toolLabel(name: string, argsJson: string): string {
  const args = parseArgs(argsJson);
  const str = (key: string): string | undefined => field(args, argsJson, key);
  const path = str("path");

  switch (name) {
    case "read_file":
      return path ? `Reading ${path}` : "Reading a file";
    case "write_file":
      return path ? `Writing ${path}` : "Writing a file";
    case "edit_file":
      return path ? `Editing ${path}` : "Editing a file";
    case "multi_edit": {
      const edits = args["edits"];
      const n = Array.isArray(edits) ? edits.length : undefined;
      return path ? `Editing ${path}${n ? ` (${n} changes)` : ""}` : "Editing a file";
    }
    case "delete_file":
      return path ? `Deleting ${path}` : "Deleting a file";
    case "list_dir":
      return `Listing ${path || "."}`;
    case "glob": {
      const pattern = str("pattern");
      return pattern ? `Searching for files matching ${truncate(pattern, 50)}` : "Searching for files";
    }
    case "grep": {
      const pattern = str("pattern");
      const inPath = path && path !== "." ? ` in ${path}` : "";
      return pattern ? `Searching for "${truncate(pattern, 40)}"${inPath}` : "Searching file contents";
    }
    case "bash": {
      const description = str("description");
      const command = str("command");
      if (description) return `Running: ${truncate(description, 70)}`;
      return command ? `Running: ${truncate(command, 60)}` : "Running a command";
    }
    case "task_output": {
      const id = str("task_id");
      return id ? `Checking background task ${id}` : "Checking background tasks";
    }
    case "task_stop": {
      const id = str("task_id");
      return id ? `Stopping background task ${id}` : "Stopping a background task";
    }
    case "todowrite":
      return "Updating task list";
    case "todoread":
      return "Reading task list";
    case "question":
      return "Asking a clarifying question";
    case "webfetch": {
      const url = str("url");
      return url ? `Fetching ${truncate(url, 60)}` : "Fetching a URL";
    }
    case "apply_patch":
      return "Applying a patch";
    case "exec_command": {
      const id = args["session_id"];
      return typeof id === "number" ? `Running a command in shell session ${id}` : "Starting a shell session";
    }
    case "write_stdin": {
      const id = args["session_id"];
      return typeof id === "number" ? `Sending input to shell session ${id}` : "Sending input to a shell session";
    }
    case "remember":
      return "Saving a note about you";
    case "explore": {
      const d = str("description");
      return d ? `Investigating: ${truncate(d, 60)}` : "Delegating an investigation";
    }
    case "plan": {
      const d = str("description");
      return d ? `Planning: ${truncate(d, 60)}` : "Planning";
    }
    case "agent": {
      const type = str("subagent_type");
      const d = str("description");
      const label = type ? `${type} agent` : "an agent";
      return d ? `Launching ${label}: ${truncate(d, 50)}` : `Launching ${label}`;
    }
    case "parallel_agents": {
      const tasks = args["tasks"];
      const n = Array.isArray(tasks) ? tasks.length : undefined;
      return n ? `Launching ${n} parallel agents` : "Launching parallel agents";
    }
    case "workflow": {
      const mode = str("mode");
      return mode ? `Running a ${mode} workflow` : "Running a workflow";
    }
    case "send_message": {
      const to = str("to");
      return to ? `Continuing agent ${to}` : "Continuing an agent";
    }
    case "list_agents":
      return "Listing active agents";
    case "tool_search": {
      const q = str("query");
      return q ? `Looking up tools for "${truncate(q, 40)}"` : "Looking up available tools";
    }
    case "skill": {
      const n = str("name");
      return n ? `Loading skill: ${n}` : "Loading a skill";
    }
    case "exit_plan_mode":
      return "Presenting the plan for approval";
    default:
      return `Running ${name}`;
  }
}

/** Technical one-liner for Verbose/Debug: the raw tool name plus its (optionally summarized) arguments. */
export function toolTechnicalDetail(name: string, argsJson: string, full: boolean): string {
  const shown = full ? argsJson : truncate(argsJson, 120);
  return `${name}(${shown})`;
}
