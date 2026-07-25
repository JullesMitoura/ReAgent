/**
 * Port of src/user_profile.py: the user profile (~/.reagent/USER.md), the
 * counterpart to CONTEXT.md. CONTEXT.md describes the PROJECT; USER.md describes
 * the USER and applies across all projects. Hand-editable Markdown file; the
 * remember tool appends durable facts to the "Learned preferences" section.
 *
 * Path: config.userProfileFile (AGENT_USER_PROFILE overrides; the tests
 * swap the field directly).
 */

import fs from "node:fs";
import path from "node:path";

import { config } from "./config.js";
import { getLogger } from "./logs.js";

const log = getLogger("user_profile");

// Mutable caps for the tests (equivalent of monkeypatching _MAX_CHARS):
// the profile is distilled, not a log. Above this, remember refuses and instructs
// to trim (the user can edit the file by hand whenever they want).
export const profileLimits = {
  maxChars: 6_000,
  maxFactChars: 300,
};

const LEARNED_HEADER = "## Learned preferences";

const TEMPLATE =
  `# User profile

User preferences that apply to ALL projects. Edit freely;
the agent also appends facts to the "Learned preferences" section (remember tool).

## About
- name: (unknown)

## Code style
- (none yet)

## Avoids
- (none yet)

` +
  LEARNED_HEADER +
  "\n";

function profilePath(): string {
  return config.userProfileFile;
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Creates USER.md with the template on first run. Never throws. */
export function ensure(): void {
  const p = profilePath();
  if (isFile(p)) return;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, TEMPLATE, "utf8");
    log.info("user profile: created %s", p);
  } catch (e) {
    log.warning("user profile: could not create (%s)", e instanceof Error ? e.message : e);
  }
}

/** USER.md body to inject into the system prompt ("" if unavailable). */
export function load(): string {
  ensure();
  try {
    return fs.readFileSync(profilePath(), "utf8").trim();
  } catch {
    return "";
  }
}

/**
 * Writes a durable fact about the user to the Learned preferences section.
 *
 * Dedup by exact line; refuses giant facts and a full file. The file is
 * agent state (outside the project), so it does not go through write permission.
 */
export function remember(fact: string): string {
  const cleaned = String(fact).split(/\s+/).filter(Boolean).join(" ").trim();
  if (!cleaned) return "Error: empty fact";
  if (cleaned.length > profileLimits.maxFactChars) {
    return `Error: fact too long (${cleaned.length} chars, max ${profileLimits.maxFactChars}); distill it`;
  }
  ensure();
  const p = profilePath();
  let body: string;
  try {
    body = fs.readFileSync(p, "utf8");
  } catch (e) {
    return `Error: could not read user profile: ${e instanceof Error ? e.message : e}`;
  }
  const line = `- ${cleaned}`;
  if (body.split(/\r\n|\r|\n/).includes(line)) {
    return "Already known (no change).";
  }
  if (body.length + line.length + 1 > profileLimits.maxChars) {
    return (
      `Error: user profile is full (${body.length} chars, max ${profileLimits.maxChars}). ` +
      "Ask the user to trim ~/.reagent/USER.md before adding more."
    );
  }
  if (!body.includes(LEARNED_HEADER)) {
    body = body.trimEnd() + "\n\n" + LEARNED_HEADER + "\n";
  }
  body = body.trimEnd() + "\n" + line + "\n";
  try {
    fs.writeFileSync(p, body, "utf8");
  } catch (e) {
    return `Error: could not write user profile: ${e instanceof Error ? e.message : e}`;
  }
  log.info("user profile: remembered (%d chars)", cleaned.length);
  return `Remembered: ${cleaned}`;
}
