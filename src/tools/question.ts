/**
 * Port of src/tools/question.py: the tool that lets the LLM ask the user
 * mid-task.
 *
 * The Python module-global handler becomes the TurnContext questionHandler
 * (MIGRATION_SPEC section 4.1): non-terminal fronts (server) inject their own.
 * With no handler and no TTY, a literal synthetic answer (runs in CI without
 * blocking).
 *
 * Claude Code AskUserQuestion rules:
 * - Sub-agents never ask (allowQuestion=false).
 * - A single option is not a decision: auto-proceed, do not interrupt.
 * - Prefer 2–4 options when offering choices.
 */

import readline from "node:readline/promises";

import { currentTurn } from "../turn-context.js";

function cleanOptions(options?: string[] | null): string[] {
  if (!options) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const o of options) {
    const t = String(o).trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

export async function question(question: string, options?: string[] | null): Promise<string> {
  const turn = currentTurn();
  // Sub-agents cannot interrupt the user; they decide and note assumptions instead.
  if (turn && turn.allowQuestion === false) {
    return "(questions are disabled for sub-agents; choose the best option and proceed, noting your assumption)";
  }

  const clean = cleanOptions(options);
  // A question with a single option has no decision in it (Claude Code rule).
  // Do not interrupt the user; treat that path as chosen and continue.
  if (clean.length === 1) {
    return `(a question needs at least two distinct options; proceeding with "${clean[0]}" as the chosen approach)`;
  }

  const handler = turn?.questionHandler;
  if (handler) return handler(question, clean);
  if (!process.stdin.isTTY) {
    return "(user unavailable in non-interactive mode; choose the best option and proceed)";
  }

  process.stdout.write(`\n\x1b[1;35m? ${question}\x1b[0m\n`);
  if (clean.length) {
    clean.forEach((opt, i) => {
      process.stdout.write(`  \x1b[36m${i + 1}\x1b[0m. ${String(opt)}\n`);
    });
    process.stdout.write("\x1b[2m(option number or free text)\x1b[0m\n");
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let answer: string;
  try {
    answer = (await rl.question("\x1b[1;35m→ \x1b[0m")).trim();
  } finally {
    rl.close();
  }
  if (clean.length && /^\d+$/.test(answer)) {
    const n = Number(answer);
    if (n >= 1 && n <= clean.length) return String(clean[n - 1]);
  }
  return answer || "(no answer)";
}
