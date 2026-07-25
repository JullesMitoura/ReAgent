/**
 * Single shared entry point for reading one line of interactive input from
 * the terminal (permission prompts, the question tool, the one-time project
 * trust prompt).
 *
 * Root cause this fixes: permissions.ts/question.ts/trust.ts each used to
 * create their OWN `readline.createInterface({ input: process.stdin, ... })`
 * per prompt. In the REPL, a persistent readline.Interface already owns
 * process.stdin for the whole session (repl.ts's makePromptSession); a
 * SECOND interface on the SAME stdin stream, once closed, leaves that shared
 * stream in a state the first interface can no longer read from — the next
 * `rl.question()` call on the REPL's own interface never registers as
 * pending I/O, so Node considers the event loop empty and exits right there,
 * surfacing as "Warning: Detected unsettled top-level await" at the
 * bin/reagent.js entry point instead of returning to the `❯` prompt.
 *
 * The fix: the REPL installs its persistent interface here once
 * (setSharedLineReader); every interactive prompt reads through askLine(),
 * which reuses that SAME interface instead of creating a conflicting one.
 * Contexts with no persistent interface (-p, exec) have nothing installed,
 * so askLine() falls back to a one-off readline.Interface exactly as before
 * — safe there, since nothing else is holding process.stdin open.
 */

import readline from "node:readline/promises";

export type LineReader = (prompt: string) => Promise<string>;

let sharedReader: LineReader | null = null;

/** Installs (or clears, with null) the process's single shared line reader. */
export function setSharedLineReader(reader: LineReader | null): void {
  sharedReader = reader;
}

/** Reads one line of input, prompting with `prompt`. */
export async function askLine(prompt: string): Promise<string> {
  if (sharedReader) return sharedReader(prompt);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}
