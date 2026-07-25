/**
 * Port of src/commands.py: custom commands (.reagent/commands/*.md and
 * ~/.reagent/commands/*.md), opencode style.
 *
 * Each .md file becomes a REPL command (/name). The body is the prompt sent
 * to the agent, with argument expansion: $ARGUMENTS receives the whole line;
 * $1..$9, the positionals. Optional frontmatter (--- description: ... ---)
 * feeds /help. Project commands override the global ones of the same name;
 * built-ins beat customs (custom lookup only in the REPL fallback).
 *
 * No shell interpolation (opencode's !`cmd`), on purpose: nothing runs a
 * command outside the agent's normal permission flow.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { config } from "./config.js";

const NAME_RE = /^[a-zA-Z0-9_-]+$/;
const ARG_RE = /\$ARGUMENTS|\$[1-9]/g;

export interface CustomCommand {
  description: string;
  body: string;
}

/** Simple frontmatter (`key: value` lines between ---) + body, no libs. */
function parse(text: string): [Record<string, string>, string] {
  if (text.startsWith("---")) {
    const lines = text.split(/\r\n|\r|\n/);
    for (let i = 1; i < lines.length; i++) {
      if ((lines[i] as string).trim() === "---") {
        const meta: Record<string, string> = {};
        for (const line of lines.slice(1, i)) {
          const sep = line.indexOf(":");
          if (sep !== -1) {
            meta[line.slice(0, sep).trim()] = line.slice(sep + 1).trim();
          }
        }
        return [meta, lines.slice(i + 1).join("\n").trim()];
      }
    }
  }
  return [{}, text.trim()];
}

/** name -> {body, description}. Global (~/.reagent) first; project wins. */
export function loadCommands(): Record<string, CustomCommand> {
  const commands: Record<string, CustomCommand> = {};
  const globalDir = path.join(os.homedir(), ".reagent", "commands");
  for (const base of [globalDir, path.join(config.stateDir, "commands")]) {
    let names: string[];
    try {
      names = fs
        .readdirSync(base)
        .filter((n) => n.endsWith(".md"))
        .sort();
    } catch {
      continue; // directory missing or unreadable
    }
    for (const name of names) {
      const stem = name.slice(0, -3);
      if (!NAME_RE.test(stem)) continue;
      let text: string;
      try {
        text = fs.readFileSync(path.join(base, name), "utf8");
      } catch {
        continue;
      }
      const [meta, body] = parse(text);
      if (body) commands[stem] = { body, description: meta["description"] ?? "" };
    }
  }
  return commands;
}

/** Substitutes $ARGUMENTS (whole line) and $1..$9 (positionals) in the body. */
export function expandArguments(body: string, args: string): string {
  const parts = args.split(/\s+/).filter((p) => p.length > 0);
  return body.replace(ARG_RE, (token) => {
    if (token === "$ARGUMENTS") return args;
    const idx = Number(token.slice(1));
    return idx <= parts.length ? (parts[idx - 1] as string) : "";
  });
}
