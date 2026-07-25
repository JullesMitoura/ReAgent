import { useEffect, useRef, useState } from "react";
import * as api from "./api";
import { Chat } from "./components/Chat";
import { ConfirmModal } from "./components/ConfirmModal";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { PermissionModal } from "./components/PermissionModal";
import { QuestionModal } from "./components/QuestionModal";
import { Sidebar } from "./components/Sidebar";
import { TodoPanel } from "./components/TodoPanel";
import { runMockTurn } from "./mock/agent";
import { formatLiveStatus } from "./liveStatus";
import type { OrbTone } from "./components/Orb";
import type {
  AgentBranch,
  AgentBranchStatus,
  ChatMessage,
  PermissionAnswer,
  PermissionRequest,
  QuestionRequest,
  SessionMeta,
  Todo,
  Usage,
} from "./types";

type Mode = "detecting" | "live" | "demo";
type ConfirmAction = { kind: "delete"; id: string } | { kind: "clear" };

const DEMO_SESSIONS: SessionMeta[] = [
  { id: "s1", title: "Fix the argument parser", updatedAt: "21/07 18:32", messages: 14 },
  { id: "s2", title: "Add tests for the tools module", updatedAt: "20/07 11:05", messages: 32 },
];

export default function App() {
  const [mode, setMode] = useState<Mode>("detecting");
  const [model, setModel] = useState("…");
  const [root, setRoot] = useState("");
  const [configErrors, setConfigErrors] = useState<string[]>([]);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [activeSession, setActiveSession] = useState("nova");
  const [liveSessionId, setLiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [todos, setTodos] = useState<Todo[]>([]);
  // sub-agents paralelos do turno atual (fan-out); ficam visíveis até o próximo turno
  const [branches, setBranches] = useState<AgentBranch[]>([]);
  const [usage, setUsage] = useState<Usage>({ promptTokens: 0, completionTokens: 0 });
  // janela de contexto do modelo (tokens), vinda do /api/info ou do evento usage
  const [contextWindow, setContextWindow] = useState(0);
  const [busy, setBusy] = useState(false);
  /** Ephemeral progress line (Thinking… / status) — not appended to history. */
  const [progress, setProgress] = useState<string | null>(null);
  const [queuedMessages, setQueuedMessages] = useState<string[]>([]);
  // Tom do orb POR TURNO: azul enquanto o turno gera a resposta, volta ao normal
  // quando a resposta fica pronta (vermelho se der erro). Só o turno em geração é
  // colorido; turnRef marca o turno atual, cada mensagem do assistant guarda seu
  // turnId e o Chat tinge só o turno ativo (a mudança de cor é suave via CSS).
  const [activeTone, setActiveTone] = useState<OrbTone>("neutral");
  const [activeTurn, setActiveTurn] = useState(0);
  const turnRef = useRef(0);
  const [permission, setPermission] = useState<(PermissionRequest & { id?: string }) | null>(null);
  const permissionResolver = useRef<((a: PermissionAnswer) => void) | null>(null);
  const [question, setQuestion] = useState<QuestionRequest | null>(null);
  const questionResolver = useRef<((answer: string) => void) | null>(null);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  // base de sessoes demo ainda ativas (nao deletadas): fonte para filtrar/restaurar buscas
  const demoBaseRef = useRef<SessionMeta[]>(DEMO_SESSIONS);

  const refreshSessions = () => api.listSessions().then(setSessions).catch(() => {});

  useEffect(() => {
    api
      .listSessions()
      .then((s) => {
        setMode("live");
        setSessions(s);
        api
          .getInfo()
          .then((i) => {
            setModel(i.model);
            setRoot(i.root ?? "");
            setConfigErrors(i.config_errors ?? []);
            if (i.context_window) setContextWindow(i.context_window);
          })
          .catch(() => {});
      })
      .catch(() => {
        setMode("demo");
        setSessions(DEMO_SESSIONS);
        setModel("simulated");
      });
  }, []);

  const askPermission = (req: PermissionRequest & { id?: string }) =>
    new Promise<PermissionAnswer>((resolve) => {
      permissionResolver.current = resolve;
      setPermission(req);
    });

  const answerPermission = (answer: PermissionAnswer) => {
    setPermission(null);
    if (answer === "always" && permission) {
      setMessages((m) => [
        ...m,
        { role: "system", content: `rule saved: ${permission.kind} → ${permission.suggestion}` },
      ]);
    }
    permissionResolver.current?.(answer);
    permissionResolver.current = null;
  };

  const askQuestion = (req: QuestionRequest) =>
    new Promise<string>((resolve) => {
      questionResolver.current = resolve;
      setQuestion(req);
    });

  const answerQuestion = (answer: string) => {
    setQuestion(null);
    questionResolver.current?.(answer);
    questionResolver.current = null;
  };

  const send = async (text: string) => {
    // ainda detectando o backend: nao despacha nada ate saber se e live ou demo
    if (mode === "detecting") return;
    // Durante um turno, mensagens seguem para a fila e viram novos turnos na
    // mesma sessão, sem alterar a execução que já está em andamento.
    if (busy) {
      setQueuedMessages((queue) => [...queue, text]);
      return;
    }
    setBusy(true);
    setProgress("Thinking…");
    // novo turno: incrementa o id, ativa este turno e pinta de azul (só ele)
    turnRef.current += 1;
    const myTurn = turnRef.current;
    setActiveTurn(myTurn);
    setActiveTone("coding");
    setBranches([]); // limpa o fan-out do turno anterior
    setMessages((m) => [...m, { role: "user", content: text }]);

    // updaters puros: decidem pelo estado, nunca por flags externas (StrictMode invoca 2x)
    const handlers = {
      onToolStart: (id: string, name: string, args: string) => {
        setProgress(formatLiveStatus(name, args));
        setMessages((m) => [...m, { role: "tool" as const, id, name, args, status: "running" as const }]);
      },
      onToolEnd: (id: string, result: string) => {
        setProgress("Thinking…");
        setMessages((m) =>
          m.map((msg) => (msg.role === "tool" && msg.id === id ? { ...msg, result, status: "done" as const } : msg)),
        );
      },
      onTodos: setTodos,
      askPermission,
      askQuestion,
      onToken: (chunk: string) => {
        setProgress(null);
        setMessages((m) => {
          const last = m[m.length - 1];
          if (last?.role === "assistant" && last.streaming) {
            return [...m.slice(0, -1), { ...last, content: last.content + chunk }];
          }
          // carimba o turno: o Chat pinta só as mensagens do turno ativo
          return [...m, { role: "assistant" as const, content: chunk, streaming: true, turnId: myTurn }];
        });
      },
      onStatus: (text: string) => {
        // Ephemeral progress (Thinking… / compacting) vs durable system notes
        const ephemeral =
          text === "Thinking…" ||
          text === "Thinking..." ||
          text.toLowerCase().includes("compact") ||
          text.toLowerCase().includes("retry");
        if (ephemeral) {
          setProgress(text);
          return;
        }
        setMessages((m) => [...m, { role: "system" as const, content: text }]);
      },
      // 'done' com conteudo proprio (interrupcao ou limite de iteracoes): so exibe se nada foi streamado
      onDone: (content: string, streamedAny: boolean) => {
        setProgress(null);
        if (!streamedAny && content) {
          setMessages((m) => [...m, { role: "system" as const, content }]);
        }
      },
      // fan-out de sub-agents: cria as faixas do grafo, todas rodando
      onAgentsStart: (agents: { id: string; title: string }[]) => {
        setProgress("Running agents…");
        setBranches(agents.map((a) => ({ ...a, status: "running" as const })));
      },
      onAgentUpdate: (id: string, status: AgentBranchStatus, detail?: string) =>
        setBranches((bs) => bs.map((b) => (b.id === id ? { ...b, status, detail: detail ?? b.detail } : b))),
      // join: mantém os branches com seus status finais, o usuário vê o resultado
      onAgentsEnd: () => {
        setProgress("Thinking…");
      },
    };

    try {
      if (mode === "live") {
        let sid = liveSessionId;
        if (!sid) {
          sid = await api.createSession();
          setLiveSessionId(sid);
          setActiveSession(sid);
        }
        await api.runTurn(sid, text, {
          ...handlers,
          // o servidor manda totais acumulados da sessão
          onUsage: (u) => {
            setUsage({
              promptTokens: u.promptTokens,
              completionTokens: u.completionTokens,
              cachedTokens: u.cachedTokens,
              lastPromptTokens: u.lastPromptTokens,
            });
            if (u.contextWindow) setContextWindow(u.contextWindow);
          },
        });
        refreshSessions();
      } else {
        await runMockTurn(text, {
          ...handlers,
          // o mock manda deltas por turno
          onUsage: (prompt, completion) =>
            setUsage((u) => ({
              promptTokens: u.promptTokens + prompt,
              completionTokens: u.completionTokens + completion,
            })),
        });
      }
      setActiveTone("neutral"); // volta ao normal quando a resposta e gerada
    } catch (e) {
      setActiveTone("error"); // vermelho quando teve problema
      setMessages((m) => [...m, { role: "system", content: `error: ${e instanceof Error ? e.message : e}` }]);
    } finally {
      // encerra o cursor de streaming e chips pendentes
      setMessages((m) =>
        m.map((msg) => {
          if (msg.role === "assistant" && msg.streaming) return { ...msg, streaming: false };
          if (msg.role === "tool" && msg.status === "running") return { ...msg, status: "done" as const };
          return msg;
        }),
      );
      setBusy(false);
      setProgress(null);
    }
  };

  // ⌘K / Ctrl+K: nova conversa (mesmo comportamento do botão da sidebar)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        handleNew();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  useEffect(() => {
    if (busy || queuedMessages.length === 0) return;
    const [next, ...remaining] = queuedMessages;
    setQueuedMessages(remaining);
    void send(next!);
  }, [busy, queuedMessages]);

  const stopTurn = () => {
    if (liveSessionId) api.stopTurn(liveSessionId).catch(() => {});
  };

  const deleteSession = async (id: string) => {
    if (mode === "live") {
      try {
        await api.deleteSession(id);
      } catch {
        /* já removida */
      }
      refreshSessions();
    } else {
      demoBaseRef.current = demoBaseRef.current.filter((x) => x.id !== id);
      setSessions((s) => s.filter((x) => x.id !== id));
    }
    if (id === activeSession) newConversation();
  };

  const clearHistory = async () => {
    if (mode === "live") {
      await api.deleteAllSessions().catch(() => {});
      refreshSessions();
    } else {
      demoBaseRef.current = [];
      setSessions([]);
    }
    newConversation();
  };

  const newConversation = () => {
    setMessages([]);
    setTodos([]);
    setBranches([]);
    setUsage({ promptTokens: 0, completionTokens: 0 });
    setQueuedMessages([]);
    setActiveSession("nova");
    setLiveSessionId(null);
    setActiveTone("neutral");
    setActiveTurn(0);
  };

  const selectSession = async (id: string) => {
    if (busy) return;
    if (id === "nova") {
      newConversation();
      return;
    }
    setActiveSession(id);
    setBranches([]); // fan-out é por turno, não persiste entre sessões
    if (mode === "live") {
      try {
        const detail = await api.getSession(id);
        setLiveSessionId(detail.id);
        setMessages(detail.chat);
        setTodos(detail.todos);
        setUsage(detail.usage);
        if (detail.contextWindow) setContextWindow(detail.contextWindow);
      } catch (e) {
        setMessages([{ role: "system", content: `error loading session: ${e instanceof Error ? e.message : e}` }]);
      }
    } else {
      setMessages([{ role: "system", content: "(demo: run `npm run dev:server` to use real sessions)" }]);
      setTodos([]);
    }
  };

  // acoes destrutivas nao podem rodar no meio de um turno; internamente
  // newConversation/deleteSession ainda sao chamadas apos o turno terminar
  const handleNew = () => {
    if (busy) return;
    newConversation();
  };
  const handleDelete = (id: string) => {
    if (busy) return;
    setConfirmAction({ kind: "delete", id });
  };
  // Renomear é seguro mesmo durante um turno (o backend atualiza a instância viva).
  // Otimista: a lista reflete na hora; um refresh corrige se o servidor recusar.
  const handleRename = (id: string, title: string) => {
    const apply = (list: SessionMeta[]) => list.map((s) => (s.id === id ? { ...s, title } : s));
    setSessions(apply);
    if (mode === "live") {
      api.renameSession(id, title).catch(() => {}).finally(refreshSessions);
    } else {
      demoBaseRef.current = apply(demoBaseRef.current);
    }
  };
  const handleClearAll = () => {
    if (busy) return;
    setConfirmAction({ kind: "clear" });
  };
  const confirmDestructiveAction = async () => {
    const action = confirmAction;
    setConfirmAction(null);
    if (!action) return;
    if (action.kind === "delete") await deleteSession(action.id);
    else await clearHistory();
  };

  return (
    <ErrorBoundary>
      <div className="flex h-screen gap-4 p-4 text-zinc-100 antialiased">
        <Sidebar
          mode={mode}
          root={root}
          sessions={sessions}
          activeId={activeSession}
          onSelect={selectSession}
          onNew={handleNew}
          onRename={handleRename}
          onDelete={handleDelete}
          onClearAll={handleClearAll}
        />
        <Chat
          live={mode === "live"}
          messages={messages}
          busy={busy}
          progress={progress}
          onSend={send}
          onStop={mode === "live" ? stopTurn : null}
          canQueue
          queuedMessages={queuedMessages}
          onRemoveQueued={(index) => setQueuedMessages((queue) => queue.filter((_, i) => i !== index))}
          activeTone={activeTone}
          activeTurn={activeTurn}
          usage={usage}
          model={model}
          configErrors={configErrors}
        />
        {(todos.length > 0 ||
          branches.length > 0 ||
          messages.some((m) => m.role === "tool")) && (
          <TodoPanel todos={todos} branches={branches} live={busy} messages={messages} />
        )}
        {permission && <PermissionModal request={permission} onAnswer={answerPermission} />}
        {question && <QuestionModal request={question} onAnswer={answerQuestion} />}
        {confirmAction && (
          <ConfirmModal
            title={confirmAction.kind === "delete" ? "Delete conversation?" : "Clear conversation history?"}
            description={
              confirmAction.kind === "delete"
                ? "This conversation will be permanently deleted."
                : "All conversations will be permanently deleted."
            }
            confirmLabel={confirmAction.kind === "delete" ? "Delete" : "Clear all"}
            onConfirm={confirmDestructiveAction}
            onCancel={() => setConfirmAction(null)}
          />
        )}
      </div>
    </ErrorBoundary>
  );
}
