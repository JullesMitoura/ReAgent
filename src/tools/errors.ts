/**
 * Controlled tool errors (CONTRACTS.md section 3).
 *
 * ToolError: a controlled error returned to the LLM as text; the dispatch maps
 * it to "Error: {msg}".
 * ArgumentError: replaces Python's kwargs TypeError; each tool validates its
 * own arguments and throws with a clear message; the dispatch maps it to
 * "Argument error: {msg}".
 */

export class ToolError extends Error {}

export class ArgumentError extends Error {}
