/** Situational system reminders (injected mid-turn, not into the stable system prefix). */

export const REMINDER_AGENT_LAUNCHED =
  "<system-reminder>A sub-agent was launched. Do not duplicate its work, do not invent results, and do not read or tail its raw transcript/output file (read_file, cat, tail); wait for the tool result. Treat the raw agent/task id as internal only, never quote or paste it into a user-facing reply; to continue it later, use send_message with to: <id>.</system-reminder>";

export const REMINDER_TRUNCATED_READ =
  "<system-reminder>A prior read was truncated. Grep or re-read with offset/limit if you need the omitted region; do not guess. If it truncates again, progressively shrink the requested window until you get a complete read; treat this as blocking, do not reason about or edit the file until the needed part reads in full.</system-reminder>";

export const REMINDER_DENIAL =
  "<system-reminder>The user denied a tool call. Do not retry the same action verbatim; adjust approach or ask what they prefer.</system-reminder>";

export const REMINDER_TODO_STALE =
  "<system-reminder>Your todo list still has pending or in-progress items but has not been updated in many tool rounds. Update it with todowrite: mark finished work completed and keep the current task in_progress.</system-reminder>";

export const REMINDER_VERIFY_BEFORE_DONE =
  "<system-reminder>You marked several todos completed. Before declaring the task done, verify your work (build, tests, or manual check) and report results truthfully.</system-reminder>";

/** Files changed on disk (user/linter edit) since the agent last read them. */
export function REMINDER_FILE_MODIFIED(paths: string[]): string {
  return (
    `<system-reminder>These files changed on disk since you last read them (user or linter edit): ${paths.join(", ")}. ` +
    "Do NOT revert those changes; re-read before editing. Don't mention this to the user.</system-reminder>"
  );
}

/** Wrap text as a user-role reminder message for history injection. */
export function asReminderMessage(text: string): { role: "user"; content: string } {
  return { role: "user", content: text };
}
