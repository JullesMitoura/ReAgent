/**
 * Raw-mode one-line reader for the REPL prompt, with live @file suggestions.
 *
 * Why this exists: node:readline only completes on Tab, and Cursor's integrated
 * terminal often swallows Tab before it reaches the process — so typing `@src/`
 * looked like attachments were broken. This reader shows matches as you type
 * and accepts them with Tab, Right arrow, or ↑↓ + Tab.
 *
 * Also used as the shared askLine() backend (permissions / question / trust)
 * so stdin stays owned by one reader for the whole session.
 */

import readline from "node:readline";

export type Completer = (line: string) => [string[], string];

export interface ReplAskOptions {
  /** Live @path / slash-command completion. Omit for plain y/n prompts. */
  completer?: Completer;
  /** History entries, most recent first (readline convention). */
  history?: string[];
  /** Called with the submitted line when non-empty. */
  onSubmit?: (line: string) => void;
  /** Ctrl+C while waiting: if set, called instead of rejecting. */
  onCtrlC?: () => void;
}

export class PromptClosedError extends Error {
  constructor() {
    super("prompt closed");
    this.name = "PromptClosedError";
  }
}

const MAX_SUGGESTIONS = 12;

/** @path tokens in the editable line (same shape as attachments.ts). */
const AT_TOKEN_RE = /(?<!\w)@[^\s@]+/g;

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function visibleWidth(s: string): number {
  return stripAnsi(s).length;
}

/** Highlights @file attachments in cyan so they stand out from the rest of the prompt. */
export function colorizeAttachments(text: string): string {
  return text.replace(AT_TOKEN_RE, (m) => `\x1b[36m${m}\x1b[0m`);
}

function longestCommonPrefix(strs: string[]): string {
  if (strs.length === 0) return "";
  let prefix = strs[0]!;
  for (let i = 1; i < strs.length; i++) {
    const s = strs[i]!;
    while (!s.startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
      if (!prefix) return "";
    }
  }
  return prefix;
}

/**
 * Persistent line reader. One instance owns stdin for the REPL session.
 * Concurrent ask() calls are serialized via a queue.
 */
export class ReplInput {
  private busy: Promise<void> = Promise.resolve();
  private closed = false;
  private wasRaw = false;

  /** Reads one line. Rejects with PromptClosedError on Ctrl+C (no onCtrlC) or Ctrl+D on empty. */
  ask(prompt: string, opts: ReplAskOptions = {}): Promise<string> {
    if (this.closed) return Promise.reject(new PromptClosedError());

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const prev = this.busy;
    this.busy = gate;

    return prev.then(
      () =>
        new Promise<string>((resolve, reject) => {
          this.readOne(prompt, opts, resolve, reject);
        }).finally(release),
    );
  }

  close(): void {
    this.closed = true;
    this.restoreTerminal();
  }

  private restoreTerminal(): void {
    if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
      try {
        process.stdin.setRawMode(this.wasRaw);
      } catch {
        // ignore
      }
    }
    try {
      process.stdin.pause();
    } catch {
      // ignore
    }
  }

  private readOne(
    prompt: string,
    opts: ReplAskOptions,
    resolve: (s: string) => void,
    reject: (e: Error) => void,
  ): void {
    if (!process.stdin.isTTY) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question(prompt, (answer) => {
        rl.close();
        const trimmed = answer.trim();
        if (trimmed) opts.onSubmit?.(trimmed);
        resolve(trimmed);
      });
      return;
    }

    let line = "";
    let cursor = 0;
    let historyIndex = -1;
    let stash = "";
    let suggestIndex = 0;
    let paintedRows = 0;
    let done = false;

    this.wasRaw = process.stdin.isRaw ?? false;
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();

    const clearPaint = (): void => {
      if (paintedRows > 0) {
        readline.moveCursor(process.stdout, 0, -(paintedRows - 1));
        readline.cursorTo(process.stdout, 0);
        readline.clearScreenDown(process.stdout);
      } else {
        readline.cursorTo(process.stdout, 0);
        readline.clearScreenDown(process.stdout);
      }
      paintedRows = 0;
    };

    const finish = (value: string | null, err?: Error): void => {
      if (done) return;
      done = true;
      process.stdin.removeListener("keypress", onKey);
      // Leave a clean submitted line (no suggestions overlay).
      clearPaint();
      if (err) {
        process.stdout.write("\r\n");
      } else {
        process.stdout.write(prompt + colorizeAttachments(value ?? "") + "\r\n");
      }
      this.restoreTerminal();
      if (err) reject(err);
      else {
        const trimmed = (value ?? "").trim();
        if (trimmed) opts.onSubmit?.(trimmed);
        resolve(trimmed);
      }
    };

    const activeHits = (): { hits: string[]; sub: string } => {
      if (!opts.completer) return { hits: [], sub: "" };
      const [hits, sub] = opts.completer(line);
      return { hits, sub };
    };

    const replaceFragment = (sub: string, next: string): void => {
      const before = line.slice(0, cursor);
      const at = /(?<!\w)@([^\s@]*)$/.exec(before);
      if (sub.startsWith("@") && at && at.index !== undefined) {
        line = before.slice(0, at.index) + next + line.slice(cursor);
        cursor = at.index + next.length;
        return;
      }
      if (/^\/\S*$/.test(line) && sub.startsWith("/")) {
        line = next;
        cursor = next.length;
        return;
      }
      const idx = line.lastIndexOf(sub);
      if (idx >= 0) {
        line = line.slice(0, idx) + next + line.slice(idx + sub.length);
        cursor = idx + next.length;
      } else {
        line = next;
        cursor = next.length;
      }
    };

    const applyCompletion = (): void => {
      const { hits, sub } = activeHits();
      if (hits.length === 0) return;
      const prefix = longestCommonPrefix(hits);
      let next: string;
      if (prefix.length > sub.length) {
        next = prefix;
      } else if (hits.length === 1) {
        next = hits[0]!;
      } else {
        next = hits[Math.min(suggestIndex, hits.length - 1)]!;
      }
      replaceFragment(sub, next);
      suggestIndex = 0;
      paint();
    };

    const paint = (): void => {
      clearPaint();

      const { hits, sub } = activeHits();
      const showSuggest =
        Boolean(opts.completer) &&
        hits.length > 0 &&
        (sub.startsWith("@") || (sub.startsWith("/") && line.startsWith("/")));

      // Color @paths in the input; cursor column still uses the raw `cursor`
      // index (ANSI codes are zero-width for cursorTo).
      let body = prompt + colorizeAttachments(line);
      if (showSuggest) {
        const shown = hits.slice(0, MAX_SUGGESTIONS);
        if (suggestIndex >= shown.length) suggestIndex = 0;
        const lines: string[] = [""];
        for (let i = 0; i < shown.length; i++) {
          const text = shown[i]!;
          if (i === suggestIndex) lines.push(`\x1b[36m› ${text}\x1b[0m`);
          else lines.push(`\x1b[2m  ${text}\x1b[0m`);
        }
        if (hits.length > MAX_SUGGESTIONS) {
          lines.push(`\x1b[2m  … +${hits.length - MAX_SUGGESTIONS} more\x1b[0m`);
        }
        lines.push(`\x1b[2mTab/→ accept · ↑↓ select\x1b[0m`);
        body += lines.join("\r\n");
      }

      process.stdout.write(body);

      const rowCount = (body.match(/\r\n|\n/g) ?? []).length + 1;
      paintedRows = rowCount;

      const promptLines = prompt.split(/\r\n|\n/);
      const inputRowFromTop = promptLines.length - 1;
      const inputCol = visibleWidth(promptLines[promptLines.length - 1] ?? "") + cursor;
      const rowsDownFromInput = rowCount - 1 - inputRowFromTop;
      if (rowsDownFromInput > 0) readline.moveCursor(process.stdout, 0, -rowsDownFromInput);
      readline.cursorTo(process.stdout, inputCol);
    };

    const onKey = (str: string | undefined, key: readline.Key | undefined): void => {
      if (done || !key) return;

      if (key.ctrl && key.name === "c") {
        if (opts.onCtrlC) {
          opts.onCtrlC();
          finish("");
          return;
        }
        finish(null, new PromptClosedError());
        return;
      }
      if (key.ctrl && key.name === "d") {
        if (line.length === 0) finish(null, new PromptClosedError());
        return;
      }

      if (key.name === "return" || key.name === "enter") {
        finish(line);
        return;
      }

      if (key.name === "tab") {
        applyCompletion();
        return;
      }

      if (key.name === "right" && cursor === line.length) {
        const { hits } = activeHits();
        if (hits.length > 0) {
          applyCompletion();
          return;
        }
      }

      if (key.name === "up" || key.name === "down") {
        const { hits, sub } = activeHits();
        const menuOpen =
          Boolean(opts.completer) && hits.length > 1 && (sub.startsWith("@") || sub.startsWith("/"));
        if (menuOpen) {
          const n = Math.min(hits.length, MAX_SUGGESTIONS);
          suggestIndex =
            key.name === "up" ? (suggestIndex - 1 + n) % n : (suggestIndex + 1) % n;
          paint();
          return;
        }
        const hist = opts.history ?? [];
        if (hist.length === 0) return;
        if (key.name === "up") {
          if (historyIndex < hist.length - 1) {
            if (historyIndex === -1) stash = line;
            historyIndex += 1;
            line = hist[historyIndex] ?? "";
            cursor = line.length;
            suggestIndex = 0;
            paint();
          }
        } else if (historyIndex >= 0) {
          historyIndex -= 1;
          line = historyIndex === -1 ? stash : (hist[historyIndex] ?? "");
          cursor = line.length;
          suggestIndex = 0;
          paint();
        }
        return;
      }

      if (key.name === "left") {
        if (cursor > 0) {
          cursor -= 1;
          paint();
        }
        return;
      }
      if (key.name === "right") {
        if (cursor < line.length) {
          cursor += 1;
          paint();
        }
        return;
      }
      if (key.name === "backspace") {
        if (cursor > 0) {
          line = line.slice(0, cursor - 1) + line.slice(cursor);
          cursor -= 1;
          suggestIndex = 0;
          paint();
        }
        return;
      }
      if (key.name === "delete") {
        if (cursor < line.length) {
          line = line.slice(0, cursor) + line.slice(cursor + 1);
          suggestIndex = 0;
          paint();
        }
        return;
      }
      if (key.name === "home") {
        cursor = 0;
        paint();
        return;
      }
      if (key.name === "end") {
        cursor = line.length;
        paint();
        return;
      }

      if (str && !key.ctrl && !key.meta) {
        for (const ch of str) {
          if (ch === "\x1b") continue;
          if (ch < " " && ch !== "\t") continue;
          if (ch === "\t") {
            applyCompletion();
            return;
          }
          line = line.slice(0, cursor) + ch + line.slice(cursor);
          cursor += 1;
        }
        suggestIndex = 0;
        paint();
      }
    };

    process.stdin.on("keypress", onKey);
    paint();
  }
}
