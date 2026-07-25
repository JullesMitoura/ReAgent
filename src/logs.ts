/**
 * Port of src/logs.py: minimal, file-only logging.
 *
 * Writes with rotation (1MB, 3 backups) to ~/.reagent/logs/reagent.log. Never
 * uses stdout/stderr so it does not pollute the REPL or the SSE stream. If home is
 * not writable, degrades to a null handler and never throws.
 *
 * Layering rule: this module imports nothing from the project.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const _ROOT_NAME = "reagent";

// Long runs like token/secret: >= 20 chars of base64/hex-ish without spaces.
const _TOKEN_RE = /[A-Za-z0-9_\-+/=]{20,}/g;

// Numeric levels identical to Python's logging.
const LEVELS: Record<string, number> = {
  NOTSET: 0,
  DEBUG: 10,
  INFO: 20,
  WARN: 30,
  WARNING: 30,
  ERROR: 40,
  CRITICAL: 50,
  FATAL: 50,
};

const LEVEL_NAMES: Record<number, string> = {
  10: "DEBUG",
  20: "INFO",
  30: "WARNING",
  40: "ERROR",
  50: "CRITICAL",
};

interface Handler {
  emit(line: string): void;
}

/** Null handler: destination when home is not writable. */
class NullHandler implements Handler {
  emit(_line: string): void {
    // discard
  }
}

/** Size-based rotation in the RotatingFileHandler style (maxBytes/backupCount). */
class RotatingFileHandler implements Handler {
  constructor(
    private readonly filePath: string,
    private readonly maxBytes: number,
    private readonly backupCount: number,
  ) {}

  private rollover(): void {
    for (let i = this.backupCount - 1; i >= 1; i--) {
      const src = `${this.filePath}.${i}`;
      const dst = `${this.filePath}.${i + 1}`;
      try {
        if (fs.existsSync(src)) fs.renameSync(src, dst);
      } catch {
        // IO failure on rotation: continue (better to lose a backup than throw)
      }
    }
    try {
      if (fs.existsSync(this.filePath)) fs.renameSync(this.filePath, `${this.filePath}.1`);
    } catch {
      // same as above
    }
  }

  emit(line: string): void {
    try {
      let size = 0;
      try {
        size = fs.statSync(this.filePath).size;
      } catch {
        size = 0;
      }
      if (this.maxBytes > 0 && size + Buffer.byteLength(line, "utf8") >= this.maxBytes) {
        this.rollover();
      }
      fs.appendFileSync(this.filePath, line, "utf8");
    } catch {
      // never throws: logging must never take down the agent
    }
  }
}

function asctime(d: Date): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())},${pad(d.getMilliseconds(), 3)}`
  );
}

/** Minimal %-style interpolation (enough for %s/%d/%i/%f in the codebase). */
function formatMessage(msg: string, args: unknown[]): string {
  if (!args.length) return msg;
  let i = 0;
  return msg.replace(/%[sdif]/g, (m) => {
    if (i >= args.length) return m;
    const arg = args[i++];
    if (m === "%d" || m === "%i") return String(Math.trunc(Number(arg)));
    if (m === "%f") return String(Number(arg));
    return String(arg);
  });
}

export class Logger {
  protected root: RootLogger;

  constructor(readonly name: string, root?: RootLogger) {
    // the RootLogger is its own destination (adjusted in the subclass constructor)
    this.root = root ?? (this as unknown as RootLogger);
  }

  private log(level: number, msg: string, args: unknown[]): void {
    if (level < this.root.level) return;
    const levelName = LEVEL_NAMES[level] ?? String(level);
    const line = `${asctime(new Date())} ${levelName} ${this.name} ${formatMessage(msg, args)}\n`;
    for (const handler of this.root.handlers) handler.emit(line);
  }

  debug(msg: string, ...args: unknown[]): void {
    this.log(LEVELS["DEBUG"] as number, msg, args);
  }

  info(msg: string, ...args: unknown[]): void {
    this.log(LEVELS["INFO"] as number, msg, args);
  }

  warning(msg: string, ...args: unknown[]): void {
    this.log(LEVELS["WARNING"] as number, msg, args);
  }

  error(msg: string, ...args: unknown[]): void {
    this.log(LEVELS["ERROR"] as number, msg, args);
  }
}

/** Root logger "reagent": owner of the level and the shared handlers. */
export class RootLogger extends Logger {
  level: number = LEVELS["INFO"] as number;
  readonly handlers: Handler[] = [];

  constructor() {
    super(_ROOT_NAME);
  }
}

let _configured = false;
const _root = new RootLogger();
const _children = new Map<string, Logger>();

/**
 * Configures the root logger exactly once. Idempotent: repeated calls do not
 * add duplicate handlers. Fails closed (NullHandler) and never throws.
 */
function configureRoot(): void {
  if (_configured) return;
  _configured = true;

  const levelName = (process.env.REAGENT_LOG_LEVEL ?? "INFO").trim().toUpperCase();
  _root.level = LEVELS[levelName] ?? (LEVELS["INFO"] as number);

  let handler: Handler;
  try {
    const logDir = path.join(os.homedir(), ".reagent", "logs");
    fs.mkdirSync(logDir, { recursive: true });
    handler = new RotatingFileHandler(path.join(logDir, "reagent.log"), 1_000_000, 3);
  } catch {
    // home not writable (or any IO failure): degrades silently
    handler = new NullHandler();
  }
  _root.handlers.push(handler);
}

/** Returns a child logger namespaced under the 'reagent' root, configured once. */
export function getLogger(name: string): Logger {
  configureRoot();
  if (!name || name === _ROOT_NAME) return _root;
  const fullName = `${_ROOT_NAME}.${name}`;
  let child = _children.get(fullName);
  if (!child) {
    child = new Logger(fullName, _root);
    _children.set(fullName, child);
  }
  return child;
}

/**
 * Masks secret-looking content to log tool args safely. Covers the value of
 * AZURE_OPENAI_KEY (if present in the env) and long token-like runs. Simple and
 * conservative: prefers to over-mask rather than leak.
 */
export function redact(text: string): string {
  if (!text) return text;
  let result = text;
  const key = (process.env.AZURE_OPENAI_KEY ?? "").trim();
  if (key) result = result.split(key).join("***REDACTED***");
  result = result.replace(_TOKEN_RE, "***REDACTED***");
  return result;
}
