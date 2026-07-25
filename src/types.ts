/**
 * Shared ReAgent types (the front contract in code-front/src/types.ts and the
 * SSE catalog of section 3.3 of MIGRATION_SPEC). snake_case fields are the wire
 * contract with the built front: do not rename.
 *
 * Layering rule: this module imports nothing from the project.
 */

// --- todos -------------------------------------------------------------------

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  content: string;
  status: TodoStatus;
}

// --- permissions and questions -----------------------------------------------

export type PermissionKind = "bash" | "write" | "edit" | "delete";

/** Answer the user gives to a permission request. */
export type PermissionAnswer = "once" | "always" | "deny";

/**
 * Full outcome of an askHandler: the 3 user answers plus the two synthetic
 * outcomes of the hook (turn cancellation and wait timeout). cancelled/timeout
 * deny the action, but with their own denial_message (not "deny").
 */
export type AskOutcome = PermissionAnswer | "cancelled" | "timeout";

// --- parallel sub-agents -----------------------------------------------------

export type AgentBranchStatus = "running" | "done" | "error";

// --- token usage (accumulated per session, snake_case as persisted) ----------

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  last_prompt_tokens: number;
  /** prompt tokens served by the provider's prefix cache (accumulated) */
  cached_prompt_tokens?: number;
}

// --- LLM error classification (llm/errors.ts) -------------------------------

export interface ErrorInfo {
  kind: string;
  http_status: number | null;
}

// --- messages in OpenAI chat format -----------------------------------------

export interface ToolCallFunction {
  name: string;
  arguments: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: ToolCallFunction;
}

export type ChatRole = "system" | "user" | "assistant" | "tool";

/**
 * A history message in OpenAI chat completions format. A single interface (not
 * a discriminated union) on purpose: the history persisted in SQLite came from
 * Python dicts and the agent mutates/repairs messages freely (_sanitize).
 */
export interface ChatMessage {
  role: ChatRole;
  content?: string | null;
  /** only in role: "assistant" with tool calls */
  tool_calls?: ToolCall[];
  /** only in role: "tool": id of the answered call */
  tool_call_id?: string;
  /** tolerance for extra fields coming from the persisted history */
  [key: string]: unknown;
}

// --- SSE events (discriminated union by type; 13 types) ---------------------

export type ServerEvent =
  | { type: "token"; text: string }
  | { type: "status"; text: string }
  | {
      type: "usage";
      prompt_tokens: number;
      completion_tokens: number;
      last_prompt_tokens: number;
      cached_prompt_tokens?: number;
      /** the model's context window (tokens), for the % consumed in the front */
      context_window?: number;
    }
  | { type: "tool_start"; id: string; name: string; args: string }
  | { type: "tool_end"; id: string; result: string }
  | { type: "todos"; todos: TodoItem[] }
  | {
      type: "permission_request";
      id: string;
      kind: PermissionKind;
      action: string;
      preview: string | null;
      suggestion: string;
    }
  | { type: "question_request"; id: string; question: string; options: string[] }
  | { type: "agents_start"; agents: { id: string; title: string }[] }
  | { type: "agent_update"; id: string; status: AgentBranchStatus; detail?: string }
  | { type: "agents_end" }
  | { type: "error"; message: string; error_info?: ErrorInfo }
  | { type: "done"; content: string; aborted?: true };

export type ServerEventType = ServerEvent["type"];

/** Turn event consumer (SSE server, terminal render, tests). */
export type EmitFn = (ev: ServerEvent) => void;
