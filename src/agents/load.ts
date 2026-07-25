/**
 * Load project/user agent definitions from .reagent/agents/*.md
 * Frontmatter: name, description (whenToUse), tools (comma list), max_steps,
 * plus optional: disallowed_tools (comma list removed from tools),
 * isolation ("worktree" | "none"), background (bool → supportsBackground),
 * doom_style ("main" | "worker" | "none").
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { config } from "../config.js";
import type { AgentDefinition } from "./types.js";

function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  if (!text.startsWith("---")) return { meta: {}, body: text };
  const end = text.indexOf("\n---", 3);
  if (end < 0) return { meta: {}, body: text };
  const raw = text.slice(3, end).trim();
  const body = text.slice(end + 4).replace(/^\n/, "");
  const meta: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^([\w-]+):\s*(.*)$/);
    if (!m) continue;
    let val = m[2]!.trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    meta[m[1]!] = val;
  }
  return { meta, body };
}

/** Comma list, tolerating optional [brackets] around the value. */
function parseList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

function parseBool(value: string | undefined): boolean {
  return /^(true|yes|1)$/i.test((value ?? "").trim());
}

function scanAgents(dir: string, source: "project" | "user"): AgentDefinition[] {
  const out: AgentDefinition[] = [];
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return out;
  }
  for (const file of files) {
    try {
      const text = fs.readFileSync(path.join(dir, file), "utf8");
      const { meta, body } = parseFrontmatter(text);
      const agentType = meta.name || meta.agentType || file.replace(/\.md$/, "");
      const disallowed = new Set(
        parseList(meta.disallowed_tools || meta.disallowedTools).map((t) => t.toLowerCase()),
      );
      const tools = parseList(meta.tools || "read_file,list_dir,glob,grep").filter(
        (t) => !disallowed.has(t.toLowerCase()),
      );
      const maxSteps = Number.parseInt(meta.max_steps || meta.maxSteps || "12", 10);
      const isolation = meta.isolation === "worktree" ? "worktree" : "none";
      const rawDoom = meta.doom_style || meta.doomStyle;
      const doomStyle =
        rawDoom === "main" || rawDoom === "worker" || rawDoom === "none" ? rawDoom : "none";
      const promptBody = body.trim();
      out.push({
        agentType,
        whenToUse: meta.description || meta.whenToUse || agentType,
        tools,
        maxSteps: Number.isFinite(maxSteps) ? maxSteps : 12,
        getSystemPrompt: () => promptBody,
        forceSummary:
          meta.force_summary ||
          "Step budget reached. Stop and give your final report now.",
        emptyResult: "(no report)",
        doomStyle,
        source,
        isolation,
        supportsBackground: parseBool(meta.background),
      });
    } catch {
      // skip
    }
  }
  return out;
}

/** Disk agents; project overrides user for the same agentType. */
export function loadDiskAgents(): AgentDefinition[] {
  const userDir = path.join(os.homedir(), ".reagent", "agents");
  const projectDir = path.join(config.root, ".reagent", "agents");
  const map = new Map<string, AgentDefinition>();
  for (const a of scanAgents(userDir, "user")) map.set(a.agentType, a);
  for (const a of scanAgents(projectDir, "project")) map.set(a.agentType, a);
  return [...map.values()];
}
