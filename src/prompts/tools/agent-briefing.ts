/**
 * Guidance embedded in agent / parallel_agents tool descriptions
 * (Claude Code writing-subagent-prompts + delegation restraint + Codex spawn modes).
 */

export const WRITING_SUBAGENT_PROMPTS = `
Briefing rules when spawning a sub-agent:
- A fresh sub-agent starts with ZERO context. Brief it like a smart colleague who just walked in: it has NOT seen this conversation, does not know what you tried, or why the task matters.
- Self-contained: include goal and why, relevant paths, what you already learned or ruled out, constraints, and done criteria. If you need a short response, say so ("report in under 200 words").
- Lookups: hand over the exact command. Investigations: hand over the question; prescribed steps become dead weight when the premise is wrong. Terse command-style prompts produce shallow, generic work.
- Never delegate understanding: never write "based on your findings" or "fix the bug we discussed" — prove you synthesized (paths, lines, exact change).
- Do not spawn for a handful of simple tool calls; do small work inline.
- If you spawn, commit to the delegation: do not redo their work while waiting, and do not re-derive their findings once they report.
- Trust but verify: a worker's summary is intent, not proof — check the diff before reporting success.
`.trim();

/** Full restraint block for the system prompt (Claude Code subagent-delegation-restraint). */
export const DELEGATION_RESTRAINT = `
Subagents multiply cost and time: each one re-establishes context, re-explores, and reports back. Delegate only when the payoff clearly exceeds that overhead — work that is genuinely independent, large enough to justify a fresh context, or naturally parallel:
- Do the work inline when it is a small, bounded sub-task (a few reads, one search, a short edit, a single check).
- Do not fan out multiple subagents on a single small task. Parallel subagents are for genuinely independent, sizeable tracks.
- Do not spawn a subagent merely to re-verify work you can check inline.
- When you DO have several independent read-only investigations, launch the read-only agents together in ONE message, on your own initiative.
- Keep spawn counts low: one well-briefed agent beats several vague ones.
- Requests for "depth" or "thoroughness" alone are not permission to spawn.
`.trim();

export const AGENT_LAUNCHED_REMINDER =
  "A sub-agent is running. Do not duplicate its work or invent its results; wait for its report.";

/** Codex ExplicitRequestOnly vs Proactive spawn gate text. */
export function spawnModePolicy(mode: "proactive" | "explicit"): string {
  if (mode === "explicit") {
    return (
      "Spawn policy (explicit): do NOT spawn sub-agents unless the user or applicable " +
      "AGENTS.md/skill instructions explicitly ask for sub-agents, delegation, or parallel agent work. " +
      "Thoroughness, research depth, or a large task alone do not count as permission to spawn."
    );
  }
  return (
    "Spawn policy (proactive): use sub-agents when parallel or isolated work would materially " +
    "improve speed or quality. Still skip spawning for a handful of simple tool calls."
  );
}

/** Rich description for the unified `agent` tool (when-to-launch + policy). */
export const AGENT_TOOL_DELEGATION_POLICY = `
Launch a nested agent for complex multi-step work. Prefer this unified tool over
ad-hoc explore/plan when choosing a specialist by subagent_type.

When to launch:
- Open-ended codebase investigation needing roughly 3+ independent searches → explore
- Implementation strategy / critical files → plan
- Adversarial check before declaring done → verification (spawn fresh)
- Bounded side task that needs writes → general-purpose
- Coordinator implementation slice → coordinator-worker
- Custom disk agents when their whenToUse matches

When NOT to launch:
- You already know the path → use read_file / edit_file directly
- A handful of greps or a single file read → do it inline
- Trivial Q&A that needs no tools
- After you delegated a search, do not also run the same search yourself — wait for the result

Parallelism:
- Critical-path blockers: keep local or wait on a foreground agent
- Independent research or DISJOINT write sets: launch multiple agent calls in ONE message
- Overlapping file writes: serialize; use parallel_agents only for disjoint worker tasks

Continue vs spawn:
- Correct a failure or extend recent work on the same files → send_message to that agent-id
- Independent verification of another worker's code → spawn fresh verification
- Wrong approach entirely or unrelated task → spawn fresh

Background:
- background=true returns immediately; results arrive later as <task-notification> messages
- Never invent or predict a background agent's results; give status if the user asks mid-wait
- fork=true inherits the parent system prompt (cache-friendly) for continuation-style work
`.trim();

/** Build the dynamic whenToUse block for available agents. */
export function formatAgentTypesBlock(
  agents: Array<{ agentType: string; whenToUse: string }>,
): string {
  if (agents.length === 0) return "";
  return (
    "Available agent types:\n" +
    agents.map((a) => `- ${a.agentType}: ${a.whenToUse}`).join("\n")
  );
}
