/**
 * Model-invoked skill tool: loads the full SKILL.md body on demand.
 */

import { ArgumentError } from "../tools/errors.js";
import { registerTool } from "../tools/index.js";
import { registerToolMeta } from "../tools/orchestration.js";
import { listSkillCatalog, loadSkill } from "./load.js";

export async function skillTool(name: string): Promise<string> {
  const skill = loadSkill(name);
  if (!skill) {
    const available = listSkillCatalog()
      .map((s) => s.name)
      .join(", ");
    return `Error: unknown skill '${name}'. Available: ${available || "(none)"}`;
  }
  return `# Skill: ${skill.name}\n\n${skill.description}\n\n${skill.body}`;
}

export const SKILL_SCHEMA = {
  type: "function",
  function: {
    name: "skill",
    description:
      "Load the full body of a named skill (playbook). Use when a skill from the " +
      "system catalog matches the task; do not load skills you do not need.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill name from the catalog" },
      },
      required: ["name"],
    },
  },
};

registerTool("skill", (a) => {
  const name = a["name"];
  if (typeof name !== "string") throw new ArgumentError("missing required argument: 'name'");
  return skillTool(name);
});

registerToolMeta({ name: "skill", isConcurrencySafe: true, isReadOnly: true });
