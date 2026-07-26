/**
 * Skills shipped with ReAgent itself (no .reagent/skills/ authoring required).
 * Lowest precedence in listSkillCatalog(): a user or project skill with the
 * same name overrides the bundled one.
 */

export interface BundledSkill {
  name: string;
  description: string;
  userInvocable: boolean;
  body: string;
}

export const BUNDLED_SKILLS: BundledSkill[] = [
  {
    name: "simplify",
    description: "Review the code you just changed for reuse, simplification, and efficiency, then apply the fixes.",
    userInvocable: true,
    body: `Review the code changed in this session (git diff against the base you started from) for quality issues, then apply the fixes directly. This is a quality pass, not a bug hunt: do not go looking for unrelated defects.

Look for:
- Duplicated logic that could reuse an existing helper, or a new one worth extracting only if the duplication is real (3+ call sites, not 2).
- Unnecessary abstraction: interfaces, options objects, or config flags with exactly one caller.
- Dead code: unused exports, unreachable branches, leftover debug statements.
- Naming that no longer matches what the code does after edits.
- Error handling or validation for situations that cannot actually happen.

For each issue, apply the fix with edit_file; do not just report it. Re-run the relevant tests after each fix. Stop when the diff is clean; do not restructure code you did not touch this session.`,
  },
  {
    name: "stuck",
    description: "Diagnose a frozen, looping, or unresponsive agent session and suggest or take a concrete next step.",
    userInvocable: true,
    body: `Diagnose why the current session (or a process it started) seems stuck, and propose or take a concrete next step. Work through these checks in order, stopping as soon as one explains it:

1. Background work: call task_output (or /tasks-equivalent) to see if a background bash task or agent is still running, and how long it has been running. A long-running dev server or build is not "stuck", it's expected.
2. Doom loop: look at the last several tool calls for three or more identical calls in a row (same tool, same arguments). If found, that is the doom-loop breaker firing; the fix is to change approach, not retry the same call.
3. Pending approval: check whether a permission prompt is awaiting a response the user has not seen (e.g. terminal scrolled away, or a background task waiting on write_stdin).
4. Hung process: if a bash/exec_command call has run far longer than the task should take, use task_output to check its output for where it is blocked (e.g. waiting on stdin, a network call with no timeout), and task_stop it if it is truly wedged.
5. Context exhaustion: an extremely long session can genuinely stall on huge context; /compact frees it up.

Report which of these applies with concrete evidence (task id, the repeated call, the process output), and either fix it directly (task_stop, a different approach) or tell the user exactly what to do.`,
  },
  {
    name: "skillify",
    description: "Turn the workflow just completed in this session into a reusable skill under .reagent/skills/.",
    userInvocable: true,
    body: `Turn the workflow just completed in this session into a reusable skill.

1. Identify the general, repeatable procedure behind what was just done (not the specific file names or values from this run, the steps themselves).
2. If the name, one-line description, or whether it should be user-invocable (available as /<name>) is not obvious, ask the user; otherwise propose sensible defaults and proceed.
3. Write .reagent/skills/<name>/SKILL.md with this exact frontmatter shape:

---
name: <kebab-case-name>
description: <one line, specific enough to know when to use it>
user-invocable: true
---

<body: numbered or bulleted steps generalized from this session, written for an agent with zero context on this specific run>

4. Confirm the file was written and give the user the exact command to invoke it (/<name>).`,
  },
  {
    name: "debug",
    description: "General debugging playbook: reproduce, isolate, form one hypothesis, verify the fix actually resolves it.",
    userInvocable: true,
    body: `Debug the reported problem methodically instead of guessing.

1. Reproduce it first. Find or write the smallest command/test that reliably triggers the failure before touching any code.
2. Read the actual error: full stack trace, exact message, exit code, or diff between expected and actual output. Do not paraphrase from memory.
3. Isolate: narrow to the smallest failing case (fewest lines, smallest input) that still reproduces it; this usually reveals the real cause directly.
4. Form exactly one hypothesis at a time and test it with a targeted read or a minimal diagnostic (a temporary log line, a smaller repro), not a speculative code change.
5. Fix the root cause, not the symptom; if the true fix is large, say so and propose the smallest correct change.
6. Verify by re-running the exact reproduction from step 1, not just "the tests pass" if the bug was never covered by a test. Add a regression test when practical.
7. Remove any temporary diagnostics (extra logging, debug flags) added along the way.`,
  },
];
