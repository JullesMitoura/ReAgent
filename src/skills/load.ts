/**
 * Skill discovery under user/project .reagent/skills directories
 * (each skill is a folder with SKILL.md). Progressive disclosure:
 * catalog metadata is cheap; full body loads on demand.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { config } from "../config.js";

export interface SkillMeta {
  name: string;
  description: string;
  userInvocable: boolean;
  /** Absolute path to SKILL.md */
  path: string;
  source: "user" | "project";
}

export interface Skill extends SkillMeta {
  body: string;
}

interface Frontmatter {
  name?: string;
  description?: string;
  "user-invocable"?: boolean | string;
}

function parseFrontmatter(text: string): { meta: Frontmatter; body: string } {
  if (!text.startsWith("---")) {
    return { meta: {}, body: text };
  }
  const end = text.indexOf("\n---", 3);
  if (end < 0) return { meta: {}, body: text };
  const raw = text.slice(3, end).trim();
  const body = text.slice(end + 4).replace(/^\n/, "");
  const meta: Frontmatter = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^([\w-]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1]!;
    let val = m[2]!.trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key === "user-invocable") {
      meta["user-invocable"] = val === "true" || val === "yes" || val === "1";
    } else if (key === "name") {
      meta.name = val;
    } else if (key === "description") {
      meta.description = val;
    }
  }
  return { meta, body };
}

function scanDir(dir: string, source: "user" | "project"): SkillMeta[] {
  const out: SkillMeta[] = [];
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const skillFile = path.join(dir, name, "SKILL.md");
    try {
      if (!fs.statSync(skillFile).isFile()) continue;
      const text = fs.readFileSync(skillFile, "utf8");
      const { meta } = parseFrontmatter(text);
      const skillName = meta.name || name;
      out.push({
        name: skillName,
        description: meta.description || skillName,
        userInvocable: Boolean(meta["user-invocable"]),
        path: skillFile,
        source,
      });
    } catch {
      // skip unreadable
    }
  }
  return out;
}

/** Catalog only (no bodies). Project skills override user skills with the same name. */
export function listSkillCatalog(): SkillMeta[] {
  const userDir = path.join(os.homedir(), ".reagent", "skills");
  const projectDir = path.join(config.root, ".reagent", "skills");
  const map = new Map<string, SkillMeta>();
  for (const s of scanDir(userDir, "user")) map.set(s.name, s);
  for (const s of scanDir(projectDir, "project")) map.set(s.name, s);
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Load full skill body by name; null if missing. */
export function loadSkill(name: string): Skill | null {
  const meta = listSkillCatalog().find((s) => s.name === name);
  if (!meta) return null;
  try {
    const text = fs.readFileSync(meta.path, "utf8");
    const { body } = parseFrontmatter(text);
    return { ...meta, body: body.trim() };
  } catch {
    return null;
  }
}

/** User-invocable skills as slash-command prompts (name → body template). */
export function userInvocableSkills(): SkillMeta[] {
  return listSkillCatalog().filter((s) => s.userInvocable);
}
