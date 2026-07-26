// Labels for the dynamic blocks appended at the end of the system prompt (volatile
// blocks, assembled last to keep the stable prefix friendly to the provider's
// cache). Text copied byte for byte from src/agent.py; the context label
// carries the U+2014 em dash from the original, written as \u2014 in the source.
export const USER_PROFILE_LABEL =
  "User profile (USER.md, applies across all projects; honor these preferences and tailor " +
  "explanation depth to the user's known background):";

export const CONTEXT_LABEL =
  "Project context (auto-generated CONTEXT.md \u2014 orient yourself from this):";

// Label for the team's instruction files (AGENTS.md, CLAUDE.md).
export function projectInstructionsLabel(name: string): string {
  return `Project instructions (${name}):`;
}
