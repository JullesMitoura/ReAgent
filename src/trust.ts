/**
 * Project trust gate (security fix): a project directory must not be able to
 * silently escalate its own danger level just by shipping a committed
 * .reagent/hooks.json or .reagent/config.json. The first time reagent runs
 * interactively against a project that asks for one of those (auto_approve,
 * allow_dangerous, permission_mode: bypass, or any hooks.json at all), the
 * user is asked once, explicitly, to trust it; the grant is persisted next to
 * permissions.json/config.json, as .reagent/trusted (same "marker file next to
 * the project's other .reagent state" idiom as permissions.ts's
 * permissions_migrated marker written by migrateBannedRules()).
 *
 * Layering rule: this module imports ./config.js only (same layer as
 * permissions.ts/session.ts). NOTE: config.ts itself must stay a leaf module
 * ("imports nothing above types.ts", see its own header), so it does NOT
 * import this file back; its setRoot() carries a tiny private duplicate of
 * isProjectTrusted()'s fs check instead (see isTrustedProjectDir() there).
 * Both read/write the exact same path (<root>/.reagent/trusted) so they never
 * disagree.
 */

import fs from "node:fs";
import path from "node:path";

import { config } from "./config.js";
import { askLine } from "./lib/interactive-line.js";

const TRUST_MARKER = "trusted";

/** True when `root` (a project directory) was explicitly trusted before. */
export function isProjectTrusted(root: string): boolean {
  try {
    return fs.existsSync(path.join(root, ".reagent", TRUST_MARKER));
  } catch {
    return false;
  }
}

/** Persists the trust grant for `root` (mkdir -p, same idiom as saveRule()). */
export function trustProject(root: string): void {
  const stateDir = path.join(root, ".reagent");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, TRUST_MARKER), `trusted ${new Date().toISOString()}\n`);
}

export interface TrustFindings {
  hooksPresent: boolean;
  /** Subset of "auto_approve" | "allow_dangerous" | "permission_mode". */
  dangerousKeys: string[];
}

/**
 * Re-reads the CURRENT project's .reagent/hooks.json and config.json (raw,
 * independent of config.ts's own already-recomputed/downgraded fields) to
 * report exactly what is file-sourced and dangerous, for the one-time warning.
 */
function findFileDangers(): TrustFindings {
  const hooksPresent = fs.existsSync(path.join(config.stateDir, "hooks.json"));
  const dangerousKeys: string[] = [];
  try {
    const raw = fs.readFileSync(config.configFile, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const dict = parsed as Record<string, unknown>;
      if (dict["auto_approve"] === true) dangerousKeys.push("auto_approve");
      if (dict["allow_dangerous"] === true) dangerousKeys.push("allow_dangerous");
      if (
        typeof dict["permission_mode"] === "string" &&
        dict["permission_mode"].trim().toLowerCase() === "bypass"
      ) {
        dangerousKeys.push("permission_mode");
      }
    }
  } catch {
    // no config.json / unreadable / invalid JSON: config.ts already surfaces
    // its own warning for this; nothing dangerous to report from here.
  }
  return { hooksPresent, dangerousKeys };
}

/**
 * True when the CURRENT project (config.root) has a file-sourced reason to
 * need a one-time trust review: a hooks.json is present, or config.json asks
 * for a dangerous flag - AND the project is not trusted yet - AND none of
 * those flags is ALSO backed by an env var or a sticky CLI flag this session
 * (a user's own --yolo / AGENT_AUTO_APPROVE=1 / --allow-dangerous is an
 * explicit ask, not a surprise, and must keep working exactly as before).
 */
export function needsTrustPrompt(): boolean {
  if (isProjectTrusted(config.root)) return false;
  const { hooksPresent, dangerousKeys } = findFileDangers();
  if (hooksPresent) return true;
  if (dangerousKeys.length === 0) return false;

  const envAutoApprove = (process.env.AGENT_AUTO_APPROVE ?? "0") === "1";
  const envAllowDangerous = (process.env.AGENT_ALLOW_DANGEROUS ?? "0") === "1";
  const envMode = (process.env.AGENT_PERMISSION_MODE ?? "").trim().toLowerCase();
  const envBypass = envMode === "bypass" || envMode === "yolo" || envMode === "auto";

  if (dangerousKeys.includes("auto_approve") && !config.forceAutoApprove && !envAutoApprove) {
    return true;
  }
  if (dangerousKeys.includes("allow_dangerous") && !config.forceAllowDangerous && !envAllowDangerous) {
    return true;
  }
  if (dangerousKeys.includes("permission_mode") && !config.forceAutoApprove && !envBypass) {
    return true;
  }
  return false;
}

function printOut(text: string): void {
  process.stdout.write(text + "\n");
}

/**
 * One-time interactive trust prompt for the CURRENT project (config.root).
 * TTY only; matches permissions.ts's ask() posture for `!process.stdin.isTTY`
 * (never blocks a non-interactive run - just returns false without asking).
 * Reads via lib/interactive-line.js's shared askLine(), same as
 * permissions.ts's promptChoice() and the question tool — never its own
 * ad-hoc readline.Interface, which would conflict with a REPL's persistent
 * one on the same stdin (see that module's doc comment).
 */
export async function promptTrust(): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const { hooksPresent, dangerousKeys } = findFileDangers();
  if (!hooksPresent && dangerousKeys.length === 0) return false;

  printOut(`\n⚠ Project not trusted: ${config.root}`);
  if (hooksPresent) {
    printOut(
      "  - .reagent/hooks.json is present: it can run shell commands automatically " +
        "(e.g. on SessionStart, before every tool call).",
    );
  }
  if (dangerousKeys.length > 0) {
    printOut(`  - .reagent/config.json requests: ${dangerousKeys.join(", ")}`);
  }
  printOut("  Only trust projects whose .reagent files you have reviewed yourself.");

  const raw = (await askLine("[y]es, trust this project / [n]o (n): ")).trim().toLowerCase();
  const trusted = raw === "y" || raw === "yes";
  if (trusted) trustProject(config.root);
  return trusted;
}
