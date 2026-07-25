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
]);

// Substrings that, present in the uppercased name, mark the variable as sensitive.
const SECRET_SUBSTRINGS = ["KEY", "SECRET", "TOKEN", "PASSWORD", "CREDENTIAL"] as const;

/** Copy of process.env without keys that carry secrets (fail-closed). */
export function scrubbedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (SECRET_KEYS.has(name)) continue;
    const upper = name.toUpperCase();
    if (SECRET_SUBSTRINGS.some((sub) => upper.includes(sub))) continue;
    env[name] = value;
  }
  return env;
}
