export type ChatMessage =
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string;
      streaming?: boolean;
      turnId?: number;
      /** Ephemeral status under the orb while waiting (Thinking…). */
      progress?: string;
    }
  | { role: "tool"; id: string; name: string; args: string; result?: string; status: "running" | "done" }
  | { role: "system"; content: string };

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface Todo {
  content: string;
  status: TodoStatus;
}

export interface PermissionRequest {
  kind: "bash" | "write" | "edit" | "delete";
  action: string;
  preview?: string;
  /** padrão sugerido para "sempre permitir", ex.: "src/**" ou "git status" */
  suggestion: string;
}

export type PermissionAnswer = "once" | "always" | "deny";

export interface SessionMeta {
  id: string;
  title: string;
  updatedAt: string;
  /** epoch ms of the last update; used for date grouping and relative time. */
  updatedAtMs?: number;
  messages: number;
  /** trecho destacado quando o item vem de uma busca full-text */
  snippet?: string;
}

export type AgentBranchStatus = "running" | "done" | "error";

/** Sub-agent despachado em paralelo pelo agente principal (fan-out). */
export interface AgentBranch {
  id: string;
  title: string;
  status: AgentBranchStatus;
  /** linha curta de progresso: última ferramenta usada ou resumo final */
  detail?: string;
}

export interface QuestionRequest {
  id: string;
  question: string;
  options: string[];
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  /** tokens de prompt servidos pelo cache de prefixo do provedor (acumulado) */
  cachedTokens?: number;
  /** tamanho do último prompt enviado ao modelo (o contexto atual) */
  lastPromptTokens?: number;
}

/**
 * Eventos emitidos pelo backend via SSE (ver server.py).
 * União discriminada por `type`: cada caso expõe seus próprios campos.
 */
export type ServerEvent =
  | { type: "token"; text: string }
  | { type: "tool_start"; id: string; name: string; args: string }
  | { type: "tool_end"; id: string; result: string }
  | { type: "todos"; todos: Todo[] }
  | {
      type: "usage";
      prompt_tokens: number;
      completion_tokens: number;
      cached_prompt_tokens?: number;
      last_prompt_tokens: number;
      /** janela de contexto do modelo (tokens), para o % consumido */
      context_window?: number;
    }
  | { type: "status"; text: string }
  | {
      type: "permission_request";
      id: string;
      kind: "bash" | "write" | "edit" | "delete";
      action: string;
      preview?: string;
      suggestion: string;
    }
  | { type: "question_request"; id: string; question: string; options: string[] }
  | { type: "agents_start"; agents: { id: string; title: string }[] }
  | { type: "agent_update"; id: string; status: AgentBranchStatus; detail?: string }
  | { type: "agents_end" }
  | { type: "error"; message: string }
  | { type: "done"; content: string };
