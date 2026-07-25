/**
 * Port of src/config.py: mutable singleton recomputed by setRoot().
 *
 * Errors in .reagent/config.json NEVER bring down startup: they become warnings
 * in configErrors and the offending key falls back to the default (the rest of
 * the file still applies). Precedence: sticky CLI flag > env > config.json > default.
 *
 * Node adaptation (MIGRATION_SPEC section 4.6): setRoot does NOT call
 * process.chdir; anything that relied on the cwd in Python must use config.root
 * explicitly (spawn cwd, relative path resolution).
 *
 * Layering rule: this module imports nothing above types.ts.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  parsePermissionMode,
  type PermissionMode,
} from "./modes.js";

// Characters per tool result in history (not configurable).
export const MAX_TOOL_OUTPUT = 30_000;

// Directories ignored in searches and blocked for read/write.
// .reagent included: the agent cannot read sessions nor edit its own permissions.
export const IGNORED_DIRS: ReadonlySet<string> = new Set([
  ".git", ".venv", "venv", "node_modules", "__pycache__",
  ".idea", ".vscode", ".reagent", ".codeagent",
]);

// Files the agent can never read or write (secrets kept out of the LLM context).
// Denylist for the FILE tools only (read_file/write_file/edit_file/...); this
// does NOT restrict the bash tool, which can already read anything the OS user can.
export const PROTECTED_FILES: ReadonlySet<string> = new Set([
  ".env", ".env.local", ".env.production",
  ".npmrc", ".netrc", "id_rsa", "id_ed25519", "credentials.json",
]);

// Keys accepted in .reagent/config.json; the rest produces a warning with a suggestion.
export const KNOWN_KEYS: ReadonlySet<string> = new Set([
  "max_iterations", "compact_threshold_tokens", "auto_approve",
  "allow_dangerous", "webfetch", "subagent", "subagent_max_steps",
  "parallel_agents", "parallel_max_agents", "parallel_max_steps",
  "max_agent_concurrency", "max_tool_concurrency",
  "sandbox_mode", "sandbox_network", "exec_sessions", "exec_session_max",
  "notify", "context_file", "context_cooldown_hours", "protect_app_source",
  "llm_timeout_seconds", "permission_timeout_seconds", "max_completion_tokens",
  "pack_context", "tool_output_keep_turns", "tool_output_protect_tokens",
  "tool_output_prune_minimum", "tool_output_stub_threshold",
  "tool_output_stub_head", "compact_keep_last", "context_window_tokens",
  "situational_git", "plan_mode", "permission_mode", "coordinator", "worktree_agents",
  "deferred_tools", "workflow", "verbosity",
]);

// --- terminal/UI verbosity (Claude Code style progressive disclosure) --------

/**
 * How much execution detail the terminal renderer shows.
 * - quiet: spinner + streamed answer + errors only (no tool/task chatter)
 * - normal: friendly one-line tool descriptions, task list, final summary
 * - verbose: normal + a technical line (tool name + summarized args) per call
 * - debug: raw tool calls/results, full JSON, no summarization
 */
export type Verbosity = "quiet" | "normal" | "verbose" | "debug";

export const VERBOSITY_LEVELS: readonly Verbosity[] = ["quiet", "normal", "verbose", "debug"] as const;

export function parseVerbosity(raw: string | undefined | null): Verbosity | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  if ((VERBOSITY_LEVELS as readonly string[]).includes(v)) return v as Verbosity;
  if (v === "minimal" || v === "silent" || v === "quiet-mode") return "quiet";
  return null;
}

/**
 * Own .env parser (no dependency). Reads <dir>/.env, does not overwrite
 * variables already defined (same semantics as load_dotenv) and never throws.
 */
export function loadDotenv(dir: string = process.cwd()): void {
  let text: string;
  try {
    text = fs.readFileSync(path.join(dir, ".env"), "utf8");
  } catch {
    return;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice(7).trim();
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    const quoted =
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")));
    if (quoted) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotenv();

// --- helpers -----------------------------------------------------------------

/** Approximation of Python's repr() for the warning messages. */
function repr(value: unknown): string {
  if (typeof value === "string") return `'${value}'`;
  if (value === null) return "null";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Small inline Levenshtein, only to suggest the closest config key. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min((curr[j - 1] as number) + 1, (prev[j] as number) + 1, (prev[j - 1] as number) + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length] as number;
}

/** Closest known key (similarity >= 0.6), or null. */
function closestKey(key: string): string | null {
  let best: string | null = null;
  let bestScore = 0;
  for (const known of KNOWN_KEYS) {
    const dist = levenshtein(key, known);
    const score = 1 - dist / Math.max(key.length, known.length, 1);
    if (score >= 0.6 && score > bestScore) {
      bestScore = score;
      best = known;
    }
  }
  return best;
}

/**
 * True when `root` was explicitly trusted via trust.ts's trustProject().
 * Intentionally a private duplicate of trust.ts's isProjectTrusted(): config.ts
 * stays a leaf module ("imports nothing above types.ts", see the header above)
 * so it cannot import trust.ts, which itself depends on config.ts. Both read
 * the exact same marker path, so they can never disagree.
 */
function isTrustedProjectDir(root: string): boolean {
  try {
    return fs.existsSync(path.join(root, ".reagent", "trusted"));
  } catch {
    return false;
  }
}

function expandUser(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~" + path.sep)) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

/**
 * Tolerant realpath: a nonexistent path resolves the closest existing parent
 * and reattaches the rest (practical equivalent of the non-strict Path.resolve()).
 */
export function realpathSafe(p: string): string {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync(abs);
  } catch {
    const parent = path.dirname(abs);
    if (parent === abs) return abs;
    return path.join(realpathSafe(parent), path.basename(abs));
  }
}

/** Extracts 1-based line/column from V8's SyntaxError (fallback: computes from position). */
function jsonErrorLineCol(message: string, text: string): { line: number; col: number } {
  const lc = /line (\d+) column (\d+)/.exec(message);
  if (lc) return { line: Number(lc[1]), col: Number(lc[2]) };
  const pos = /position (\d+)/.exec(message);
  if (pos) {
    const n = Math.min(Number(pos[1]), text.length);
    const before = text.slice(0, n);
    const line = before.split("\n").length;
    const lastNl = before.lastIndexOf("\n");
    return { line, col: n - lastNl };
  }
  return { line: 1, col: 1 };
}

// --- app's own protected directories -----------------------------------------

// ReAgent's own source code: the write tools never create/overwrite/delete
// here (reading stays free). No-op when the agent works on another project
// (the paths fall outside the ROOT). Disableable with "protect_app_source".
const _thisDir = realpathSafe(path.dirname(fileURLToPath(import.meta.url))); // src/ or dist/
const _pkgRoot = path.dirname(_thisDir);

export const APP_PROTECTED_DIRS: string[] = [_thisDir];
for (const sibling of ["src", "dist", "bin", "static", "ui"]) {
  const candidate = path.join(_pkgRoot, sibling);
  try {
    if (fs.statSync(candidate).isDirectory()) {
      const real = realpathSafe(candidate);
      if (!APP_PROTECTED_DIRS.includes(real)) APP_PROTECTED_DIRS.push(real);
    }
  } catch {
    // sibling missing: ignore
  }
}

// --- Config class -------------------------------------------------------------

export class Config {
  // Project root directory: the agent can only read/write inside it.
  root!: string;
  stateDir!: string;
  sessionsDir!: string;
  permissionsFile!: string;
  configFile!: string;

  /** Config warnings for the current project; recomputed on each setRoot. */
  readonly configErrors: string[] = [];

  maxIterations!: number;
  compactThreshold!: number;
  autoApprove!: boolean;
  allowDangerous!: boolean;
  enableWebfetch!: boolean;
  enableSubagent!: boolean;
  subagentMaxSteps!: number;
  enableParallel!: boolean;
  parallelMaxAgents!: number;
  parallelMaxSteps!: number;
  /** Max sub-agents actually running at once (bounds LLM streams + shells). */
  maxAgentConcurrency!: number;
  /** Max concurrency-safe tools dispatched at once within a round. */
  maxToolConcurrency!: number;
  sandboxMode!: string;
  sandboxNetwork!: boolean;
  enableExecSessions!: boolean;
  execSessionMax!: number;
  notifyCommand!: string[];
  contextFile!: boolean;
  contextCooldownHours!: number;
  protectAppSource!: boolean;
  llmTimeout!: number;
  permissionTimeout!: number;
  maxCompletionTokens!: number;
  packContext!: boolean;
  toolOutputKeepTurns!: number;
  toolOutputProtectTokens!: number;
  toolOutputPruneMinimum!: number;
  toolOutputStubThreshold!: number;
  toolOutputStubHead!: number;
  compactKeepLast!: number;
  contextWindowTokens!: number;

  // CLI flag stickies: once turned on, a later /cd does not drop them.
  forceAutoApprove = false;
  forceAllowDangerous = false;
  /**
   * Autonomy mode (Claude Code style). `planMode` remains a convenience mirror
   * of permissionMode === "plan" for older call sites.
   */
  permissionMode: PermissionMode = "default";
  /** Inject capped git status into the volatile prompt suffix. */
  situationalGit = true;
  /** Coordinator mode: main agent orchestrates; prefers spawn over inline work. */
  coordinatorMode = false;
  /**
   * Sub-agent spawn policy (Codex ExplicitRequestOnly vs Proactive).
   * - proactive: spawn when parallel work improves speed/quality (default)
   * - explicit: spawn only when the user (or AGENTS.md/skill) asks for agents
   */
  spawnMode: "proactive" | "explicit" = "proactive";
  /** Parallel workers may use git worktrees when true. */
  worktreeAgents = false;
  /**
   * When true, niche tools (webfetch, exec sessions, remember, workflow) are
   * hidden until activated via tool_search for the turn.
   */
  enableDeferredTools = false;
  /** Opt-in deterministic multi-agent workflow tool. */
  enableWorkflow = false;
  /** Terminal rendering detail level; see the Verbosity type. */
  verbosity: Verbosity = "normal";
  /** CLI flag sticky: once set (--quiet/--verbose/--debug), a later /cd keeps it. */
  private forceVerbosity: Verbosity | null = null;

  /** @deprecated Prefer permissionMode === "plan". */
  get planMode(): boolean {
    return this.permissionMode === "plan";
  }
  set planMode(on: boolean) {
    if (on) this.permissionMode = "plan";
    else if (this.permissionMode === "plan") this.permissionMode = "default";
  }

  /** User's global USER.md (AGENT_USER_PROFILE overrides); mutable in tests. */
  userProfileFile: string =
    process.env.AGENT_USER_PROFILE || path.join(os.homedir(), ".reagent", "USER.md");

  constructor(initialRoot: string = process.cwd()) {
    this.setRoot(initialRoot);
  }

  // LLM env read on demand (the .env was already loaded at module import).
  get azureOpenAIEndpoint(): string {
    return (process.env.AZURE_OPENAI_ENDPOINT ?? "").trim();
  }
  get azureOpenAIKey(): string {
    return (process.env.AZURE_OPENAI_KEY ?? "").trim();
  }
  get azureOpenAILLM(): string {
    return (process.env.AZURE_OPENAI_LLM ?? "").trim();
  }
  get azureOpenAIApiVersion(): string {
    return (process.env.AZURE_OPENAI_API_VERSION ?? "2024-12-01-preview").trim();
  }

  private getInt(cfg: Record<string, unknown>, key: string, def: number): number {
    const value = key in cfg ? cfg[key] : def;
    if (typeof value !== "number" || !Number.isInteger(value)) {
      this.configErrors.push(
        `config.json: '${key}' should be an integer, got ${repr(value)}; using ${def}`,
      );
      return def;
    }
    return value;
  }

  private getFloat(cfg: Record<string, unknown>, key: string, def: number): number {
    const value = key in cfg ? cfg[key] : def;
    if (typeof value !== "number" || Number.isNaN(value)) {
      this.configErrors.push(
        `config.json: '${key}' should be a number, got ${repr(value)}; using ${def}`,
      );
      return def;
    }
    return value;
  }

  private getBool(cfg: Record<string, unknown>, key: string, def: boolean): boolean {
    const value = key in cfg ? cfg[key] : def;
    if (typeof value !== "boolean") {
      this.configErrors.push(
        `config.json: '${key}' should be true/false, got ${repr(value)}; using ${def}`,
      );
      return def;
    }
    return value;
  }

  /**
   * Changes the working directory: sandbox, state and sessions become its own.
   * Re-reads .reagent/config.json and recomputes every key in the same order as
   * Python (the context window BEFORE the threshold, which derives from it).
   */
  setRoot(p: string): string {
    const expanded = expandUser(String(p));
    let stat: fs.Stats;
    try {
      stat = fs.statSync(path.resolve(expanded));
    } catch {
      throw new Error(`directory not found: ${p}`);
    }
    if (!stat.isDirectory()) throw new Error(`not a directory: ${p}`);
    const newRoot = fs.realpathSync(path.resolve(expanded));

    this.root = newRoot;
    this.stateDir = path.join(newRoot, ".reagent");
    // migration from the project's old name
    const legacy = path.join(newRoot, ".codeagent");
    try {
      if (fs.statSync(legacy).isDirectory() && !fs.existsSync(this.stateDir)) {
        fs.renameSync(legacy, this.stateDir);
      }
    } catch {
      // no legacy (or no access): continue
    }
    this.sessionsDir = path.join(this.stateDir, "sessions");
    this.permissionsFile = path.join(this.stateDir, "permissions.json");
    this.configFile = path.join(this.stateDir, "config.json");

    this.configErrors.length = 0;
    let fileCfg: Record<string, unknown> = {};
    let rawText: string | null = null;
    try {
      rawText = fs.readFileSync(this.configFile, "utf8");
    } catch {
      rawText = null; // no config.json (or unreadable): silent defaults
    }
    if (rawText !== null) {
      let parsed: unknown = {};
      try {
        parsed = JSON.parse(rawText);
      } catch (e) {
        const { line, col } = jsonErrorLineCol(e instanceof Error ? e.message : "", rawText);
        this.configErrors.push(
          `config.json invalid (line ${line}, column ${col}): using defaults`,
        );
        parsed = {};
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        this.configErrors.push("config.json should be a JSON object: using defaults");
        parsed = {};
      }
      fileCfg = parsed as Record<string, unknown>;
    }
    for (const key of Object.keys(fileCfg)) {
      if (!KNOWN_KEYS.has(key)) {
        const hint = closestKey(key);
        let msg = `config.json: unknown key '${key}'`;
        if (hint) msg += ` (did you mean '${hint}'?)`;
        this.configErrors.push(msg);
      }
    }

    this.maxIterations = this.getInt(fileCfg, "max_iterations", 40);

    // Model context window, computed BEFORE the threshold that derives from it.
    const envWindow = process.env.AGENT_CONTEXT_WINDOW_TOKENS;
    if (envWindow) {
      const parsed = Number.parseInt(envWindow, 10);
      this.contextWindowTokens = Number.isFinite(parsed)
        ? parsed
        : this.getInt(fileCfg, "context_window_tokens", 128_000);
    } else {
      this.contextWindowTokens = this.getInt(fileCfg, "context_window_tokens", 128_000);
    }

    // Without explicit config, derived from the window (62.5%: 80k of 128k);
    // with config, clamped at 90% of the window to never compact too late.
    const cap = Math.trunc(this.contextWindowTokens * 0.9);
    if ("compact_threshold_tokens" in fileCfg) {
      const raw = this.getInt(
        fileCfg,
        "compact_threshold_tokens",
        Math.trunc(this.contextWindowTokens * 0.625),
      );
      if (raw > cap) {
        const msg =
          `config.json: compact_threshold_tokens ${raw} is above 90% of the ` +
          `${this.contextWindowTokens}-token window; clamped to ${cap}`;
        this.configErrors.push(msg);
        process.stderr.write(msg + "\n");
      }
      this.compactThreshold = Math.min(raw, cap);
    } else {
      this.compactThreshold = Math.trunc(this.contextWindowTokens * 0.625);
    }

    // Opt-in OR: sticky OR env=="1" OR config.
    const envAutoApprove = (process.env.AGENT_AUTO_APPROVE ?? "0") === "1";
    const fileAutoApprove = this.getBool(fileCfg, "auto_approve", false);
    this.autoApprove = this.forceAutoApprove || envAutoApprove || fileAutoApprove;
    if (this.forceAutoApprove) {
      this.permissionMode = "bypass";
    }
    // Security gate: a project-committed config.json alone must not be able to
    // flip auto-approve on with zero user action. Only downgrade when the FILE
    // was the sole source (not the sticky --yolo flag, not the env var: those
    // are the user's own explicit ask and must keep working unchanged).
    if (fileAutoApprove && !this.forceAutoApprove && !envAutoApprove && !isTrustedProjectDir(this.root)) {
      this.autoApprove = false;
      this.configErrors.push(
        "config.json: 'auto_approve' is true, but this project is not trusted; run reagent " +
          "in this directory interactively once to review and trust it, or pass --yolo yourself.",
      );
    }

    const envAllowDangerous = (process.env.AGENT_ALLOW_DANGEROUS ?? "0") === "1";
    const fileAllowDangerous = this.getBool(fileCfg, "allow_dangerous", false);
    this.allowDangerous = this.forceAllowDangerous || envAllowDangerous || fileAllowDangerous;
    if (
      fileAllowDangerous &&
      !this.forceAllowDangerous &&
      !envAllowDangerous &&
      !isTrustedProjectDir(this.root)
    ) {
      this.allowDangerous = false;
      this.configErrors.push(
        "config.json: 'allow_dangerous' is true, but this project is not trusted; run reagent " +
          "in this directory interactively once to review and trust it, or pass --allow-dangerous yourself.",
      );
    }

    this.enableWebfetch =
      (process.env.AGENT_ENABLE_WEBFETCH ?? "0") === "1" ||
      this.getBool(fileCfg, "webfetch", false);

    // Opt-out AND: env != "0" AND config (on by default). The explore sub-agent
    // is read-only, so it is safe to offer without an explicit opt-in.
    this.enableSubagent =
      (process.env.AGENT_ENABLE_SUBAGENT ?? "") !== "0" &&
      this.getBool(fileCfg, "subagent", true);
    this.subagentMaxSteps = this.getInt(fileCfg, "subagent_max_steps", 12);

    // Opt-out AND: env != "0" AND config (on by default).
    this.enableParallel =
      (process.env.AGENT_ENABLE_PARALLEL ?? "") !== "0" &&
      this.getBool(fileCfg, "parallel_agents", true);
    this.parallelMaxAgents = this.getInt(fileCfg, "parallel_max_agents", 10);
    this.parallelMaxSteps = this.getInt(fileCfg, "parallel_max_steps", 15);
    // Rolling window: how many sub-agents actually run at once (<= parallelMaxAgents).
    this.maxAgentConcurrency = Math.max(
      1,
      this.getInt(fileCfg, "max_agent_concurrency", 4),
    );
    this.maxToolConcurrency = Math.max(
      1,
      this.getInt(fileCfg, "max_tool_concurrency", 8),
    );

    const fileSandbox = "sandbox_mode" in fileCfg ? fileCfg["sandbox_mode"] : "auto";
    this.sandboxMode = String(process.env.AGENT_SANDBOX || fileSandbox);
    this.sandboxNetwork =
      (process.env.AGENT_SANDBOX_NETWORK ?? "0") === "1" ||
      this.getBool(fileCfg, "sandbox_network", false);

    this.enableExecSessions =
      process.platform !== "win32" &&
      (process.env.AGENT_EXEC_SESSIONS ?? "") !== "0" &&
      this.getBool(fileCfg, "exec_sessions", true);
    this.execSessionMax = this.getInt(fileCfg, "exec_session_max", 8);

    const rawNotify = "notify" in fileCfg ? fileCfg["notify"] : [];
    this.notifyCommand = Array.isArray(rawNotify) ? rawNotify.map((x) => String(x)) : [];

    this.contextFile =
      (process.env.AGENT_CONTEXT_FILE ?? "") !== "0" &&
      this.getBool(fileCfg, "context_file", true);
    this.contextCooldownHours = this.getFloat(fileCfg, "context_cooldown_hours", 24);

    this.protectAppSource = this.getBool(fileCfg, "protect_app_source", true);

    const envLlmTimeout = process.env.AGENT_LLM_TIMEOUT;
    this.llmTimeout = envLlmTimeout
      ? Number(envLlmTimeout)
      : this.getFloat(fileCfg, "llm_timeout_seconds", 600);

    const envPermTimeout = process.env.AGENT_PERMISSION_TIMEOUT;
    this.permissionTimeout = envPermTimeout
      ? Number(envPermTimeout)
      : this.getFloat(fileCfg, "permission_timeout_seconds", 300);

    const envMaxCompletion = process.env.AGENT_MAX_COMPLETION_TOKENS;
    if (envMaxCompletion) {
      const parsed = Number.parseInt(envMaxCompletion, 10);
      this.maxCompletionTokens = Number.isFinite(parsed)
        ? parsed
        : this.getInt(fileCfg, "max_completion_tokens", 0);
    } else {
      this.maxCompletionTokens = this.getInt(fileCfg, "max_completion_tokens", 0);
    }

    this.packContext =
      (process.env.AGENT_PACK_CONTEXT ?? "") !== "0" &&
      this.getBool(fileCfg, "pack_context", true);
    this.toolOutputKeepTurns = this.getInt(fileCfg, "tool_output_keep_turns", 2);
    this.toolOutputProtectTokens = this.getInt(fileCfg, "tool_output_protect_tokens", 16_000);
    this.toolOutputPruneMinimum = this.getInt(fileCfg, "tool_output_prune_minimum", 8_000);
    this.toolOutputStubThreshold = this.getInt(fileCfg, "tool_output_stub_threshold", 600);
    this.toolOutputStubHead = this.getInt(fileCfg, "tool_output_stub_head", 300);

    this.compactKeepLast = this.getInt(fileCfg, "compact_keep_last", 12);

    this.situationalGit =
      (process.env.AGENT_SITUATIONAL_GIT ?? "") !== "0" &&
      this.getBool(fileCfg, "situational_git", true);

    this.coordinatorMode =
      (process.env.AGENT_COORDINATOR ?? "") === "1" ||
      this.getBool(fileCfg, "coordinator", false);
    const envSpawn = (process.env.AGENT_SPAWN_MODE ?? "").trim().toLowerCase();
    const fileSpawn =
      typeof fileCfg["spawn_mode"] === "string" ? String(fileCfg["spawn_mode"]).trim().toLowerCase() : "";
    const spawnRaw = envSpawn || fileSpawn;
    if (spawnRaw === "explicit" || spawnRaw === "proactive") {
      this.spawnMode = spawnRaw;
    } else {
      this.spawnMode = "proactive";
    }
    this.worktreeAgents =
      (process.env.AGENT_WORKTREE_AGENTS ?? "") === "1" ||
      this.getBool(fileCfg, "worktree_agents", false);
    this.enableDeferredTools =
      (process.env.AGENT_DEFERRED_TOOLS ?? "") === "1" ||
      this.getBool(fileCfg, "deferred_tools", false);
    this.enableWorkflow =
      (process.env.AGENT_ENABLE_WORKFLOW ?? "") === "1" ||
      this.getBool(fileCfg, "workflow", false);

    // verbosity: sticky CLI flag wins; else env; else file; else "normal"
    const envVerbosity = parseVerbosity(process.env.AGENT_VERBOSITY);
    const fileVerbosity = parseVerbosity(
      typeof fileCfg["verbosity"] === "string" ? String(fileCfg["verbosity"]) : "",
    );
    this.verbosity = this.forceVerbosity ?? envVerbosity ?? fileVerbosity ?? "normal";

    // permission_mode: sticky CLI wins; else env; else file; else keep current sticky
    const envMode = parsePermissionMode(process.env.AGENT_PERMISSION_MODE ?? "");
    const fileMode = parsePermissionMode(
      typeof fileCfg["permission_mode"] === "string" ? String(fileCfg["permission_mode"]) : "",
    );
    if (envMode) {
      this.setPermissionMode(envMode);
    } else if (fileMode && !this.forceAutoApprove) {
      // Security gate: config.json alone must not be able to flip the project
      // into bypass (full auto-approve) mode without the user ever trusting it.
      if (fileMode === "bypass" && !isTrustedProjectDir(this.root)) {
        this.configErrors.push(
          "config.json: 'permission_mode' requests 'bypass', but this project is not trusted; " +
            "run reagent in this directory interactively once to review and trust it, or pass --yolo yourself.",
        );
      } else if (this.permissionMode === "default" || this.permissionMode === "plan") {
        // Don't clobber bypass set via --yolo earlier in the same process unless file says bypass
        this.permissionMode = fileMode;
      }
    } else if (this.getBool(fileCfg, "plan_mode", false) && this.permissionMode === "default") {
      this.permissionMode = "plan";
    }

    return this.root;
  }

  /** Turns on --yolo stickily: autoApprove does not drop on a later /cd. */
  setYolo(): void {
    this.forceAutoApprove = true;
    this.autoApprove = true;
    this.permissionMode = "bypass";
  }

  /** Turns on --allow-dangerous stickily (analogous to setYolo). */
  setAllowDangerous(): void {
    this.forceAllowDangerous = true;
    this.allowDangerous = true;
  }

  /** Sets permission mode stickily for this process. */
  setPermissionMode(mode: PermissionMode): void {
    this.permissionMode = mode;
    if (mode === "bypass") {
      this.forceAutoApprove = true;
      this.autoApprove = true;
    } else {
      // Leaving bypass: drop sticky yolo so setRoot can recompute autoApprove.
      this.forceAutoApprove = false;
      this.autoApprove = false;
    }
  }

  /** Turns on --plan stickily: read-only until user exits plan mode. */
  setPlanMode(on = true): void {
    this.setPermissionMode(on ? "plan" : "default");
  }

  setCoordinatorMode(on = true): void {
    this.coordinatorMode = on;
  }

  setSpawnMode(mode: "proactive" | "explicit"): void {
    this.spawnMode = mode;
  }

  /** Sets the terminal verbosity stickily for this process (a later /cd keeps it). */
  setVerbosity(v: Verbosity): void {
    this.forceVerbosity = v;
    this.verbosity = v;
  }

  /** True if the path is inside ReAgent's own source code. */
  isAppSource(p: string): boolean {
    if (!this.protectAppSource) return false;
    const rp = realpathSafe(p);
    return APP_PROTECTED_DIRS.some((d) => rp === d || rp.startsWith(d + path.sep));
  }

  /** Throws if the required LLM variables are missing from .env. */
  validate(): void {
    const required: Record<string, string> = {
      AZURE_OPENAI_ENDPOINT: this.azureOpenAIEndpoint,
      AZURE_OPENAI_KEY: this.azureOpenAIKey,
      AZURE_OPENAI_LLM: this.azureOpenAILLM,
    };
    const missing = Object.keys(required).filter((name) => !required[name]);
    if (missing.length) {
      throw new Error(`Missing variables in .env: ${missing.join(", ")}`);
    }
  }
}

/** Mutable singleton (same model as Python's config module). */
export const config = new Config();

/** Alias of the warnings array (same instance mutated in place by setRoot). */
export const CONFIG_ERRORS: string[] = config.configErrors;
