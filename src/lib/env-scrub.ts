/**
 * A single environment scrub for subprocesses (unifies the duplicated copies of
 * shell.py and exec_sessions.py). Fail-closed: removes the exact Azure keys and
 * any variable whose uppercased name contains a secret marker.
 *
 * Layering rule: lib/* imports nothing from the project.
 */

// Exact names always removed before running the subprocess.
const SECRET_KEYS: ReadonlySet<string> = new Set([
  "AZURE_OPENAI_ENDPOINT",
  "AZURE_OPENAI_KEY",
  "AZURE_OPENAI_LLM",
  "AZURE_OPENAI_API_VERSION",
  "DATABASE_URL",
  "CONNECTION_STRING",
]);

// Substrings that, present in the uppercased name, mark the variable as sensitive.
const SECRET_SUBSTRINGS = [
  "KEY",
  "SECRET",
  "TOKEN",
  "PASSWORD",
  "CREDENTIAL",
  "APIKEY",
  "PRIVATE",
] as const;

// AUTH is sensitive in most names, but a few well-known sockets/helpers must
// survive so git-over-ssh and similar tooling keep working inside bash.
const AUTH_ALLOWLIST: ReadonlySet<string> = new Set(["SSH_AUTH_SOCK"]);

function looksSecret(name: string): boolean {
  if (SECRET_KEYS.has(name)) return true;
  const upper = name.toUpperCase();
  if (AUTH_ALLOWLIST.has(upper)) return false;
  if (SECRET_SUBSTRINGS.some((sub) => upper.includes(sub))) return true;
  // AUTH as a path segment (FOO_AUTH, AUTH_BAR, FOO_AUTH_BAR) but not bare "PATH".
  if (/(^|_)AUTH(_|$)/.test(upper)) return true;
  return false;
}

/** Copy of process.env without keys that carry secrets (fail-closed). */
export function scrubbedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (looksSecret(name)) continue;
    env[name] = value;
  }
  return env;
}
