/**
 * Cliente real do backend Hono em 127.0.0.1:8787 (proxy do Vite em dev).
 * Mesma interface de eventos do mock, o App não distingue os dois.
 */

import type {
  AgentBranchStatus,
  ChatMessage,
  ErrorInfo,
  PermissionAnswer,
  PermissionRequest,
  QuestionRequest,
  ServerEvent,
  SessionMeta,
  Todo,
  Usage,
} from "./types";

export interface LiveTurnHandlers {
  onToolStart: (id: string, name: string, args: string) => void;
  onToolEnd: (id: string, result: string) => void;
  onTodos: (todos: Todo[]) => void;
  askPermission: (req: PermissionRequest & { id: string }) => Promise<PermissionAnswer>;
  askQuestion: (req: QuestionRequest) => Promise<string>;
  onToken: (text: string) => void;
  onUsage: (usage: Usage & { lastPromptTokens: number; contextWindow?: number }) => void;
  onStatus: (text: string) => void;
  // truncated: true quando o turno parou por ter esgotado o orçamento de iterações
  // (não uma conclusão natural); ausente/false em qualquer outro "done".
  onDone: (content: string, streamedAny: boolean, truncated?: boolean) => void;
  // fan-out de sub-agents paralelos (opcionais: nem todo turno tem)
  onAgentsStart?: (agents: { id: string; title: string }[]) => void;
  onAgentUpdate?: (id: string, status: AgentBranchStatus, detail?: string) => void;
  onAgentsEnd?: () => void;
}

/** Erro de turno vindo de um evento SSE "error"; carrega o error_info do backend
 *  (kind/http_status) em vez de descartá-lo. */
export class TurnError extends Error {
  readonly errorInfo?: ErrorInfo;
  constructor(message: string, errorInfo?: ErrorInfo) {
    super(message);
    this.name = "TurnError";
    this.errorInfo = errorInfo;
  }
}

async function ok(res: Response): Promise<Response> {
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res;
}

function fmtDate(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  const date = d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
  const time = d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  return `${date} ${time}`;
}

export async function getInfo(): Promise<{ model: string; root: string; context_window?: number; config_errors?: string[] }> {
  const res = await ok(await fetch("/api/info"));
  return res.json();
}

export async function listSessions(): Promise<SessionMeta[]> {
  const res = await ok(await fetch("/api/sessions"));
  const rows: { id: string; title: string; messages: number; updated_at: number }[] = await res.json();
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    messages: r.messages,
    updatedAt: fmtDate(r.updated_at),
    updatedAtMs: r.updated_at * 1000,
  }));
}

export async function createSession(): Promise<string> {
  const res = await ok(await fetch("/api/sessions", { method: "POST" }));
  return (await res.json()).id as string;
}

export async function searchSessions(q: string): Promise<SessionMeta[]> {
  const res = await ok(await fetch(`/api/sessions/search?q=${encodeURIComponent(q)}`));
  const rows: { id: string; title: string; messages: number; updated_at: number; snippet: string }[] =
    await res.json();
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    messages: r.messages,
    updatedAt: fmtDate(r.updated_at),
    updatedAtMs: r.updated_at * 1000,
    snippet: r.snippet,
  }));
}

export async function renameSession(id: string, title: string): Promise<void> {
  await ok(
    await fetch(`/api/sessions/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    }),
  );
}

export async function deleteSession(id: string): Promise<void> {
  await ok(await fetch(`/api/sessions/${id}`, { method: "DELETE" }));
}

export async function deleteAllSessions(): Promise<void> {
  await ok(await fetch("/api/sessions", { method: "DELETE" }));
}

export async function stopTurn(id: string): Promise<void> {
  await ok(await fetch(`/api/sessions/${id}/stop`, { method: "POST" }));
}

/** Envia uma mensagem NO MEIO de um turno em execução (steering): o backend
 *  enfileira e injeta antes da próxima chamada ao modelo. */
export async function steerTurn(id: string, content: string): Promise<void> {
  await ok(
    await fetch(`/api/sessions/${id}/steer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    }),
  );
}

export async function listFiles(q: string): Promise<string[]> {
  const res = await ok(await fetch(`/api/files?q=${encodeURIComponent(q)}`));
  return res.json();
}

export async function answerQuestion(id: string, answer: string): Promise<void> {
  await ok(
    await fetch(`/api/questions/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answer }),
    }),
  );
}

export interface SessionDetail {
  id: string;
  title: string;
  chat: ChatMessage[];
  todos: Todo[];
  usage: Usage;
  contextWindow?: number;
}

/** Chamada de ferramenta no histórico bruto (formato OpenAI). */
interface RawToolCall {
  id: string;
  function: { name: string; arguments: string };
}

/** Mensagem no histórico bruto (formato OpenAI). */
interface RawMessage {
  role: string;
  content?: string;
  tool_calls?: RawToolCall[];
  tool_call_id?: string;
}

/** Converte o histórico bruto (formato OpenAI) para mensagens de exibição. */
export function toChat(raw: RawMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  const toolInfo: Record<string, { name: string; args: string }> = {};
  for (const m of raw) {
    // Oculta o resumo de compactação de histórico; o backend escreve
    // "[Summary of the earlier conversation (history compacted)]", então
    // casamos só o prefixo estável (o ack do assistant é filtrado abaixo).
    if (m.role === "user" && m.content && !m.content.startsWith("[Summary of the ")) {
      out.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      for (const tc of m.tool_calls ?? []) {
        toolInfo[tc.id] = { name: tc.function.name, args: tc.function.arguments };
      }
      if (m.content && !m.content.startsWith("Understood. I'll continue")) {
        out.push({ role: "assistant", content: m.content });
      }
    } else if (m.role === "tool" && m.tool_call_id) {
      const info = toolInfo[m.tool_call_id] ?? { name: "tool", args: "" };
      out.push({
        role: "tool",
        id: m.tool_call_id,
        name: info.name,
        args: info.args,
        result: m.content ?? "",
        status: "done",
      });
    }
  }
  return out;
}

export async function getSession(id: string): Promise<SessionDetail> {
  const res = await ok(await fetch(`/api/sessions/${id}`));
  const data = await res.json();
  return {
    id: data.id,
    title: data.title || "(untitled)",
    chat: toChat(data.messages ?? []),
    todos: data.todos ?? [],
    usage: {
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
      cachedTokens: data.usage?.cached_prompt_tokens ?? 0,
      lastPromptTokens: data.usage?.last_prompt_tokens ?? 0,
    },
    contextWindow: data.context_window,
  };
}

export async function answerPermission(id: string, answer: PermissionAnswer): Promise<void> {
  await ok(
    await fetch(`/api/permissions/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answer }),
    }),
  );
}

export async function runTurn(sessionId: string, content: string, h: LiveTurnHandlers): Promise<void> {
  const res = await ok(
    await fetch(`/api/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    }),
  );

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let streamedAny = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const line = frame.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        let ev: ServerEvent;
        try {
          ev = JSON.parse(line.slice(6)) as ServerEvent;
        } catch {
          // frame malformado: ignora em vez de derrubar o turno inteiro
          continue;
        }

        switch (ev.type) {
          case "token":
            streamedAny = true;
            h.onToken(ev.text);
            break;
          case "tool_start":
            h.onToolStart(ev.id, ev.name, ev.args);
            break;
          case "tool_end":
            h.onToolEnd(ev.id, ev.result);
            break;
          case "todos":
            h.onTodos(ev.todos);
            break;
          case "usage":
            h.onUsage({
              promptTokens: ev.prompt_tokens,
              completionTokens: ev.completion_tokens,
              cachedTokens: ev.cached_prompt_tokens ?? 0,
              lastPromptTokens: ev.last_prompt_tokens,
              contextWindow: ev.context_window,
            });
            break;
          case "status":
            h.onStatus(ev.text);
            break;
          case "permission_request": {
            // o servidor fica bloqueado até respondermos; nada chega enquanto isso
            const answer = await h.askPermission(ev);
            try {
              await answerPermission(ev.id, answer);
            } catch {
              // 404: a requisição expirou ou o turno foi interrompido; segue lendo o stream
            }
            break;
          }
          case "question_request": {
            const answer = await h.askQuestion(ev);
            try {
              await answerQuestion(ev.id, answer);
            } catch {
              // 404: a requisição expirou ou o turno foi interrompido; segue lendo o stream
            }
            break;
          }
          case "agents_start":
            h.onAgentsStart?.(ev.agents);
            break;
          case "agent_update":
            h.onAgentUpdate?.(ev.id, ev.status, ev.detail);
            break;
          case "agents_end":
            h.onAgentsEnd?.();
            break;
          case "error":
            throw new TurnError(ev.message, ev.error_info);
          case "done":
            h.onDone(ev.content ?? "", streamedAny, ev.truncated);
            break;
        }
      }
    }
  } finally {
    // garante que o corpo da resposta é liberado mesmo se um evento "error"
    // (ou um handler) lançar no meio do stream
    reader.cancel().catch(() => {});
  }
}
