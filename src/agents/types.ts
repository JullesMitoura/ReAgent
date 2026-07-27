/**
 * Typed agent definitions.
 */

export interface AgentDefinition {
  agentType: string;
  whenToUse: string;
  /** Allowlist of tool names. */
  tools: readonly string[];
  maxSteps: number;
  getSystemPrompt: (vars?: Record<string, string>) => string;
  forceSummary: string;
  emptyResult?: string;
  doomStyle?: "main" | "worker" | "none";
  source: "built-in" | "project" | "user";
  /** Inherit parent system prompt when fork=true (cache-friendly). */
  supportsFork?: boolean;
  /** May run detached and report via agents_* events. */
  supportsBackground?: boolean;
  /** Prefer a git worktree cwd when config.worktreeAgents. */
  isolation?: "none" | "worktree";
}

export interface RunAgentOptions {
  agentType: string;
  prompt: string;
  title?: string;
  /** Inherit parent system prompt prefix. */
  fork?: boolean;
  /** Parent system prompt to prepend when fork=true. */
  parentSystemPrompt?: string;
  /** Return immediately; completion arrives via agents_* events. */
  background?: boolean;
  /** Optional worktree cwd override. */
  cwd?: string;
  /** Stable id for registry / send_message continue (auto-generated when omitted). */
  sessionId?: string;
  /** Append "(agent-id: …)" footer so the parent can call send_message (default true). */
  sessionFooter?: boolean;
  onToolStart?: (name: string, argumentsJson: string) => void;
  /** Called after each tool dispatch with its result (e.g. to detect denials). */
  onToolEnd?: (name: string, result: string) => void;
}
