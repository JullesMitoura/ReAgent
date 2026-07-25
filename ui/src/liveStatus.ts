/**
 * Human-readable live status for the orb (Claude Code / Cursor style).
 * Short verb + optional target — never raw tool names.
 */

type Action = { running: string; done: string };

const ACTIONS: Record<string, Action> = {
  write_file: { running: "Writing", done: "Wrote" },
  edit_file: { running: "Editing", done: "Edited" },
  multi_edit: { running: "Editing", done: "Edited" },
  apply_patch: { running: "Patching", done: "Patched" },
  delete_file: { running: "Deleting", done: "Deleted" },
  read_file: { running: "Reading", done: "Read" },
  list_dir: { running: "Exploring", done: "Listed" },
  glob: { running: "Finding files", done: "Found" },
  grep: { running: "Searching", done: "Searched" },
  bash: { running: "Running", done: "Ran" },
  exec_command: { running: "Running", done: "Ran" },
  todowrite: { running: "Planning", done: "Updated plan" },
  todoread: { running: "Checking plan", done: "Checked plan" },
  question: { running: "Asking you", done: "Asked" },
  webfetch: { running: "Fetching", done: "Fetched" },
  explore: { running: "Exploring", done: "Explored" },
  plan: { running: "Planning", done: "Planned" },
  agent: { running: "Delegating", done: "Finished" },
  parallel_agents: { running: "Running agents", done: "Agents finished" },
  skill: { running: "Loading skill", done: "Loaded skill" },
  remember: { running: "Remembering", done: "Remembered" },
};

const FALLBACK: Action = { running: "Working", done: "Done" };

function shortTarget(name: string, args: string): string {
  try {
    const a = JSON.parse(args || "{}") as Record<string, unknown>;
    if (name === "bash" || name === "exec_command") {
      const cmd = typeof a.command === "string" ? a.command.trim() : "";
      return cmd.slice(0, 48);
    }
    if (name === "explore" || name === "plan" || name === "agent" || name === "parallel_agents") {
      if (typeof a.description === "string") return a.description.slice(0, 48);
      if (typeof a.prompt === "string") return a.prompt.slice(0, 48);
      if (typeof a.subagent_type === "string") return a.subagent_type;
      return "";
    }
    if (name === "skill" && typeof a.name === "string") return a.name.slice(0, 48);
    if ((name === "glob" || name === "grep") && typeof a.pattern === "string") {
      return a.pattern.slice(0, 48);
    }
    if (typeof a.path === "string") return a.path === "." ? "project root" : a.path.slice(0, 56);
    return "";
  } catch {
    return "";
  }
}

/** e.g. "Reading · src/agent.ts" or "Thinking…" */
export function formatLiveStatus(name: string, args = ""): string {
  const verb = (ACTIONS[name] ?? FALLBACK).running;
  const target = shortTarget(name, args);
  return target ? `${verb} · ${target}` : `${verb}…`;
}

export function toolActionLabel(name: string, done: boolean): string {
  const a = ACTIONS[name] ?? FALLBACK;
  return done ? a.done : a.running;
}

export function toolActionTarget(name: string, args: string): string {
  return shortTarget(name, args);
}

export { ACTIONS as TOOL_ACTIONS };
