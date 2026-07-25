import { useEffect, useRef, useState, type ReactElement } from "react";
import * as api from "../api";
import { formatLiveStatus } from "../liveStatus";
import type { ChatMessage, Usage } from "../types";
import { Message } from "./Message";
import { Orb, type OrbTone } from "./Orb";

interface Props {
  live: boolean;
  messages: ChatMessage[];
  busy: boolean;
  /** Live progress under the orb (Thinking…, compacting, …). */
  progress?: string | null;
  onSend: (text: string) => void;
  onStop?: (() => void) | null;
  /** Permite adicionar uma nova mensagem à fila enquanto o agente trabalha. */
  canQueue?: boolean;
  queuedMessages?: string[];
  onRemoveQueued?: (index: number) => void;
  /** Tom do turno ATIVO (coding/done/error) e qual turno está ativo: só as
   *  mensagens desse turno são tingidas; as demais voltam à cor original. */
  activeTone?: OrbTone;
  activeTurn?: number;
  /** Métricas do modelo, exibidas discretamente abaixo do compositor. */
  usage: Usage;
  model: string;
  configErrors?: string[];
}

// Sugestões do estado inicial: preenchem o input e ensinam o que o agente faz.
const SUGGESTIONS = [
  "Explain this codebase",
  "Find and fix a bug",
  "Write tests for a file",
  "Review my recent changes",
];

/* token @caminho sendo digitado no fim do texto */
const AT_TOKEN_RE = /(?<!\w)@([^\s@]*)$/;
const ATTACHMENT_RE = /(?<!\w)@([^\s@]+)/g;

function renderHighlighted(text: string) {
  const nodes: (string | ReactElement)[] = [];
  let last = 0;
  let key = 0;
  for (const match of text.matchAll(ATTACHMENT_RE)) {
    const start = match.index ?? 0;
    if (start > last) nodes.push(text.slice(last, start));
    nodes.push(<span key={key++} className="rounded bg-cyan-400/15 px-0.5 text-cyan-200">{match[0]}</span>);
    last = start + match[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  nodes.push("\u200b");
  return nodes;
}

export function Chat({
  live,
  messages,
  busy,
  progress = null,
  onSend,
  onStop,
  canQueue = false,
  queuedMessages = [],
  onRemoveQueued,
  activeTone = "neutral",
  activeTurn = 0,
  usage,
  model,
  configErrors = [],
}: Props) {
  const [input, setInput] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  const [fileIndex, setFileIndex] = useState(0);
  const [showMetrics, setShowMetrics] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);

  // so rola sozinho quando o usuario ja esta perto do fim; se ele subiu para ler,
  // nao sequestra a rolagem
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (nearBottom) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // A altura acompanha o conteúdo até três linhas. O input antigo usava uma
  // camada transparente para destacar @arquivos; em textos longos ela se
  // desalinhava durante a rolagem e escondia parte do texto digitado.
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 66)}px`;
  }, [input]);

  const syncScroll = () => {
    const textarea = textareaRef.current;
    const backdrop = backdropRef.current;
    if (textarea && backdrop) {
      backdrop.scrollTop = textarea.scrollTop;
      backdrop.scrollLeft = textarea.scrollLeft;
    }
  };
  useEffect(syncScroll, [input]);

  // autocomplete de @arquivo: consulta o backend enquanto o token é digitado
  useEffect(() => {
    const match = input.match(AT_TOKEN_RE);
    if (!live || !match) {
      setFiles([]);
      return;
    }
    let cancelled = false;
    api
      .listFiles(match[1])
      .then((f) => {
        if (!cancelled) {
          setFiles(f);
          setFileIndex(0);
        }
      })
      .catch(() => setFiles([]));
    return () => {
      cancelled = true;
    };
  }, [input, live]);

  const send = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || (busy && !canQueue)) return;
    setInput("");
    setFiles([]);
    onSend(trimmed);
  };

  const applyFile = (path: string) => {
    const match = input.match(AT_TOKEN_RE);
    if (!match) return;
    const isDir = path.endsWith("/");
    // diretório: mantém o token aberto para continuar navegando
    setInput(input.slice(0, match.index) + "@" + path + (isDir ? "" : " "));
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (files.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setFileIndex((i) => (i + 1) % files.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setFileIndex((i) => (i - 1 + files.length) % files.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        applyFile(files[fileIndex]);
        return;
      }
      if (e.key === "Escape") {
        setFiles([]);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send(input);
    }
  };

  const lastMsg = messages[messages.length - 1];
  const streamingAnswer =
    lastMsg?.role === "assistant" && lastMsg.streaming && lastMsg.content.length > 0;

  // Derive orb label from the latest running tool, else progress / Thinking…
  let liveLabel = progress || "Thinking…";
  if (busy) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!;
      if (m.role === "tool" && m.status === "running") {
        liveLabel = formatLiveStatus(m.name, m.args);
        break;
      }
    }
  }

  // Transcript de exibição: ferramentas ficam no painel de atividade, e
  // segmentos consecutivos do assistant fundem-se numa única bolha — um orb
  // por resposta. O status ao vivo anexa-se a essa mesma bolha, então o orb é
  // sempre o MESMO elemento durante o turno (nunca some/reaparece), apenas
  // muda de cor via CSS. Como fusões e ferramentas não criam nem deslocam
  // itens, os índices são estáveis e servem de chave no React.
  const items: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === "tool") continue;
    const prev = items[items.length - 1];
    if (m.role === "assistant" && prev?.role === "assistant") {
      items[items.length - 1] = {
        ...prev,
        content: prev.content && m.content ? `${prev.content}\n\n${m.content}` : prev.content + m.content,
        streaming: prev.streaming || m.streaming,
        turnId: m.turnId ?? prev.turnId,
      };
      continue;
    }
    items.push(m);
  }
  if (busy) {
    const tail = items[items.length - 1];
    if (tail?.role === "assistant" && tail.streaming) {
      // status só quando não há tokens fluindo (o cursor já sinaliza a geração)
      if (!streamingAnswer) items[items.length - 1] = { ...tail, progress: liveLabel };
    } else {
      // turno recém-iniciado, ainda sem segmento: a bolha nasce aqui e os
      // primeiros tokens preenchem este MESMO item (mesmo índice, mesma chave)
      items.push({ role: "assistant", content: "", streaming: true, turnId: activeTurn, progress: liveLabel });
    }
  }

  const composer = (
    <div className="relative mx-auto max-w-4xl">
      {showMetrics && (
        <>
          {/* click-away: fecha o popover ao clicar fora do compositor */}
          <div className="fixed inset-0" aria-hidden="true" onClick={() => setShowMetrics(false)} />
          <div className="glass absolute bottom-full right-0 z-10 mb-2 w-56 animate-fade-up rounded-xl p-3 shadow-2xl shadow-black/40">
            <div className="mb-2 flex items-center justify-between gap-3">
              <span className="text-[10px] font-semibold uppercase tracking-[0.15em] text-zinc-500">Session</span>
              <span className="truncate font-mono text-[11px] text-cyan-300">{model}</span>
            </div>
            <dl className="space-y-1.5 font-mono text-[11px] tabular-nums">
              <div className="flex items-baseline justify-between">
                <dt className="text-zinc-500">prompt</dt>
                <dd className="text-zinc-300">{usage.promptTokens.toLocaleString("en-US")}</dd>
              </div>
              <div className="flex items-baseline justify-between">
                <dt className="text-zinc-500">output</dt>
                <dd className="text-zinc-300">{usage.completionTokens.toLocaleString("en-US")}</dd>
              </div>
              <div className="flex items-baseline justify-between">
                <dt className="text-zinc-500">context</dt>
                <dd className="text-zinc-300">{(usage.lastPromptTokens ?? 0).toLocaleString("en-US")}</dd>
              </div>
              <div className="flex items-baseline justify-between">
                <dt className="text-zinc-500">cached</dt>
                <dd className="text-zinc-400">{(usage.cachedTokens ?? 0).toLocaleString("en-US")}</dd>
              </div>
            </dl>
          </div>
        </>
      )}
      {files.length > 0 && (
        <div className="glass absolute bottom-full left-0 right-0 z-10 mb-2 max-h-56 animate-fade-up overflow-y-auto rounded-xl p-1.5 shadow-2xl shadow-black/40">
          <div className="mb-1 border-b border-white/5 px-2.5 pb-1.5 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.15em] text-zinc-500">
            Attach file
          </div>
          {files.map((f, i) => (
            <button
              key={f}
              onClick={() => applyFile(f)}
              onMouseEnter={() => setFileIndex(i)}
              className={`block w-full rounded-lg px-2.5 py-1.5 text-left font-mono text-xs transition-colors duration-100 active:bg-cyan-500/25 ${
                i === fileIndex ? "bg-cyan-500/15 text-cyan-300" : "text-zinc-300"
              }`}
            >
              {f.endsWith("/") ? <span className="text-violet-400">{f}</span> : f}
            </button>
          ))}
        </div>
      )}

      <div className="rounded-xl border border-white/10 bg-zinc-900/80 px-3 py-2 transition-colors focus-within:border-cyan-400/60">
        {queuedMessages.length > 0 && (
          <div className="mb-2 flex flex-wrap items-center gap-1.5 border-b border-white/8 pb-2" aria-label="Queued messages">
            <span className="font-mono text-[10px] uppercase tracking-wide text-zinc-500">Queued</span>
            {queuedMessages.map((message, index) => (
              <button
                key={`${message}-${index}`}
                type="button"
                onClick={() => onRemoveQueued?.(index)}
                title="Remove from queue"
                className="max-w-44 truncate rounded bg-white/[0.06] px-2 py-1 text-left text-[11px] text-zinc-300 transition-colors hover:bg-red-500/10 hover:text-red-300"
              >
                {message} <span className="text-zinc-600">×</span>
              </button>
            ))}
          </div>
        )}
        <div className="flex items-end gap-3">
          <div className="relative min-w-0 flex-1">
            <div
              ref={backdropRef}
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 max-h-[66px] overflow-hidden whitespace-pre-wrap break-words py-0.5 text-[15px] leading-[22px] text-zinc-100"
            >
              {renderHighlighted(input)}
            </div>
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              onScroll={syncScroll}
              rows={1}
              spellCheck={false}
              placeholder={
                busy
                  ? canQueue
                    ? "Add a message to the queue…"
                    : "Working…"
                  : "Ask me anything…"
              }
              disabled={busy && !canQueue}
              aria-label="Message ReAgent"
              className="relative block max-h-[66px] w-full resize-none overflow-y-auto whitespace-pre-wrap break-words bg-transparent p-0 py-0.5 text-[15px] leading-[22px] text-transparent caret-cyan-300 outline-none placeholder:text-zinc-600 disabled:opacity-50"
            />
          </div>
          <button
            type="button"
            onClick={() => setShowMetrics((v) => !v)}
            aria-label="Session metrics"
            title="Session metrics"
            aria-expanded={showMetrics}
            className={`grid h-8 w-8 shrink-0 place-items-center rounded-md transition-colors hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/50 ${
              showMetrics ? "text-cyan-300" : "text-zinc-500 hover:text-zinc-300"
            }`}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-4 w-4" aria-hidden="true">
              <line x1="6" y1="20" x2="6" y2="13" />
              <line x1="12" y1="20" x2="12" y2="4" />
              <line x1="18" y1="20" x2="18" y2="9" />
            </svg>
          </button>
          {busy && onStop ? (
            <button
              onClick={onStop}
              aria-label="stop"
              title="Stop the current turn"
              className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-sm text-red-400 transition-colors hover:bg-red-500/10 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60"
            >
              ■
            </button>
          ) : (
            <button
              onClick={() => send(input)}
              disabled={busy || !input.trim()}
              aria-label="send"
              className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-lg text-cyan-400 transition-colors hover:bg-cyan-400/10 hover:text-cyan-300 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 disabled:opacity-25"
            >
              ↑
            </button>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <main className="glass flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl">
      {configErrors.length > 0 && (
        <div className="shrink-0 border-b border-amber-400/20 bg-amber-400/[0.06] px-6 py-2.5">
          <span className="text-[10px] font-semibold uppercase tracking-[0.15em] text-amber-300">Configuration</span>
          <span className="ml-2 text-xs text-amber-100/80">{configErrors[0]}</span>
        </div>
      )}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-6">
        {messages.length === 0 ? (
          <div className="flex h-full animate-fade-up flex-col items-center justify-center gap-6 text-center">
            <Orb className="h-16 w-16" reaction />
            <div>
              {/* titulo com leve gradiente na propria tipografia */}
              <p className="bg-gradient-to-br from-zinc-50 via-cyan-100/90 to-violet-200/80 bg-clip-text text-xl font-semibold tracking-tight text-transparent">
                What are we building today?
              </p>
              {!live && (
                <p className="mt-2 text-sm text-zinc-500">demo with a simulated agent</p>
              )}
            </div>
            <div className="flex max-w-lg flex-wrap justify-center gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => send(s)}
                  disabled={busy}
                  className="rounded-full border border-white/10 bg-white/[0.03] px-3.5 py-1.5 text-[13px] text-zinc-400 transition-colors hover:border-cyan-400/30 hover:bg-cyan-400/[0.06] hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-400/40 disabled:opacity-40"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="mx-auto flex max-w-4xl flex-col gap-4">
            {items.map((msg, i) => (
              <div key={`${msg.role}-${i}`}>
                <Message
                  msg={msg}
                  avatarTone={msg.role === "assistant" && msg.turnId === activeTurn ? activeTone : "neutral"}
                />
              </div>
            ))}
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      <div className="relative z-10 shrink-0 px-6 pb-4 pt-3">{composer}</div>
    </main>
  );
}
