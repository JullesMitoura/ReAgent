/**
 * Permission / autonomy modes (Claude Code style).
 *
 * - default: ask for mutating tools
 * - plan: read-only tool set; no writes / mutating bash
 * - acceptEdits: auto-approve file writes/edits/deletes; still ask for bash
 * - bypass: skip permission prompts (same sticky effect as --yolo)
 * - bare: minimal tool surface (no explore/parallel/skill/agent/plan)
 */

export type PermissionMode = "default" | "plan" | "acceptEdits" | "bypass" | "bare";

export const PERMISSION_MODES: readonly PermissionMode[] = [
  "default",
  "plan",
  "acceptEdits",
  "bypass",
  "bare",
] as const;

export function parsePermissionMode(raw: string | undefined | null): PermissionMode | null {
  if (!raw) return null;
  const v = raw.trim();
  if ((PERMISSION_MODES as readonly string[]).includes(v)) return v as PermissionMode;
  // aliases
  if (v === "yolo" || v === "auto") return "bypass";
  if (v === "accept_edits" || v === "accept-edits") return "acceptEdits";
  return null;
}

/** Tools always allowed in plan mode. */
export const PLAN_MODE_TOOLS: ReadonlySet<string> = new Set([
  "read_file",
  "list_dir",
  "glob",
  "grep",
  "todoread",
  "question",
  "exit_plan_mode",
  "skill",
  "explore",
  "plan",
  "agent",
  "send_message",
  "list_agents",
  "webfetch",
  "tool_search",
]);

/**
 * Coordinator lead tool pool (Claude Code COORDINATOR_MODE_ALLOWED_TOOLS pattern).
 * Lead orchestrates; workers write. Lead keeps read tools for trivial lookups.
 */
export const COORDINATOR_MODE_TOOLS: ReadonlySet<string> = new Set([
  "read_file",
  "list_dir",
  "glob",
  "grep",
  "todoread",
  "todowrite",
  "question",
  "skill",
  "webfetch",
  "explore",
  "plan",
  "agent",
  "parallel_agents",
  "send_message",
  "list_agents",
  "exit_plan_mode",
  "tool_search",
  "workflow",
  "remember",
]);

/** Minimal tool names for bare mode (still useful for scripting). */
export const BARE_MODE_TOOLS: ReadonlySet<string> = new Set([
  "read_file",
  "list_dir",
  "glob",
  "grep",
  "write_file",
  "edit_file",
  "multi_edit",
  "delete_file",
  "apply_patch",
  "bash",
  "todowrite",
  "todoread",
  "question",
]);

export function modeAllowsTool(mode: PermissionMode, toolName: string): boolean {
  const name = toolName.toLowerCase();
  if (mode === "plan") return PLAN_MODE_TOOLS.has(name) || PLAN_MODE_TOOLS.has(toolName);
  if (mode === "bare") return BARE_MODE_TOOLS.has(name) || BARE_MODE_TOOLS.has(toolName);
  return true;
}

/** File mutation kinds auto-approved under acceptEdits. */
export function acceptEditsAutoApproves(kind: string): boolean {
  return kind === "write" || kind === "edit" || kind === "delete";
}

export function modePromptRule(mode: PermissionMode): string {
  switch (mode) {
    case "plan":
      return (
        "- Plan mode is active: do NOT modify files or run mutating shell commands.\n" +
        "  Workflow: (1) Investigate — launch the minimum Explore agents needed in parallel " +
        "(usually 1; more only when scope is genuinely uncertain). " +
        "(2) Clarify with question only when the answer changes the plan. " +
        "(3) Design the approach (trade-offs, Critical Files). " +
        "(4) Call exit_plan_mode with the full plan for approval — never ask " +
        "'should I proceed?' or 'is the plan OK?' via question (the user cannot see the plan until exit_plan_mode)."
      );
    case "acceptEdits":
      return (
        "- Accept-edits mode: file writes/edits/deletes are auto-approved; " +
        "still request approval for shell commands."
      );
    case "bypass":
      return (
        "- Bypass mode: permission prompts are skipped; be extra careful with destructive actions."
      );
    case "bare":
      return (
        "- Bare mode: minimal tool surface (no explore/parallel/agent/skill). Prefer direct tools."
      );
    default:
      return "";
  }
}
