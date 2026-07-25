// Line fragments of the "Sandbox and approvals" section of the system prompt.
// The assembly (which lines are included) depends on sandbox.available() and the
// real config and lives in system-prompt.ts (_sandbox_rules in Python). Here we
// only keep the texts, copied byte for byte from src/agent.py.
export const SANDBOX_HEADER = "Sandbox and approvals:";

export const SANDBOX_OS_LINE =
  "- Non-dangerous shell commands run inside an OS sandbox with writes " +
  "restricted to the workspace.";

export const SANDBOX_NETWORK_LINE =
  "- Network access is blocked inside the sandbox; DNS or connection " +
  "failures there are an environment limit, not a bug in the code.";

export const SANDBOX_READONLY_LINE =
  "- Provably read-only commands (each pipeline segment is checked) run " +
  "without approval.";

export const SANDBOX_AUTO_APPROVE_LINE =
  "- Other commands run without approval prompts; be extra careful with " +
  "destructive actions.";

export const SANDBOX_APPROVAL_REQUIRED_LINE =
  "- Other actions (bash, write_file, edit_file) require user approval and " +
  "may be denied; respect denials, do not retry.";
