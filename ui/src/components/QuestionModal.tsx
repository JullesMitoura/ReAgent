import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import * as api from "../api";
import { useFocusTrap } from "../hooks/useFocusTrap";
import type { QuestionRequest } from "../types";

interface Props {
  request: QuestionRequest;
  onAnswer: (answer: string) => void;
}

// token @caminho sendo digitado no fim do texto (igual ao compositor)
const AT_TOKEN_RE = /(?<!\w)@([^\s@]*)$/;

export function QuestionModal({ request, onAnswer }: Props) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  const [fileIndex, setFileIndex] = useState(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Fechar sem responder: como o turno fica bloqueado esperando a resposta, o
  // fecho precisa resolver a pergunta. Envia uma nota curta para o agente seguir.
  const close = () => onAnswer("(the user closed the question without answering)");

  // Focus trap. Escape does nothing extra here beyond closing (the user must
  // answer); Tab/Shift+Tab cycling and focus restore on unmount are handled
  // by the shared hook.
  const { handleKeyDown } = useFocusTrap(dialogRef, { onEscape: close });

  // Foco inicial no input e restauração ao desmontar.
  // Move focus to the text input on mount, restore on unmount.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Autocomplete de @arquivo: consulta o backend enquanto o token é digitado.
  useEffect(() => {
    const match = text.match(AT_TOKEN_RE);
    if (!match) {
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
  }, [text]);

  const submit = () => {
    if (text.trim()) onAnswer(text.trim());
  };

  const applyFile = (path: string) => {
    const match = text.match(AT_TOKEN_RE);
    if (!match) return;
    const isDir = path.endsWith("/");
    // diretório: mantém o token aberto para continuar navegando
    setText(text.slice(0, match.index) + "@" + path + (isDir ? "" : " "));
    inputRef.current?.focus();
  };

  function onInputKeyDown(e: KeyboardEvent<HTMLInputElement>) {
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
        // não deixa a lista fechar nem o foco pular: aplica a seleção
        e.preventDefault();
        e.stopPropagation();
        applyFile(files[fileIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.stopPropagation();
        setFiles([]);
        return;
      }
    }
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex animate-fade items-center justify-center bg-black/70 p-4 backdrop-blur-md">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="question-modal-title"
        onKeyDown={handleKeyDown}
        className="glass relative w-full max-w-lg animate-pop-in overflow-hidden rounded-2xl border-violet-500/25 p-6 shadow-[0_0_80px_rgba(167,139,250,0.12)]"
      >
        {/* Filete de luz no topo do card. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-violet-400/50 to-transparent"
        />
        <button
          onClick={close}
          aria-label="Close"
          title="Close (Esc)"
          className="absolute right-3 top-3 grid h-7 w-7 place-items-center rounded-lg text-zinc-500 transition-colors hover:bg-white/5 hover:text-zinc-300 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/20"
        >
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" className="h-4 w-4" aria-hidden="true">
            <path d="M5 5l10 10M15 5L5 15" />
          </svg>
        </button>
        <div className="mb-4 flex items-start gap-3">
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-violet-500/15 text-violet-400 ring-1 ring-inset ring-violet-500/20">
            {/* Icone decorativo de pergunta. */}
            <svg
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.6}
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-4.5 w-4.5"
              aria-hidden
            >
              <path d="M7.2 7.3a2.9 2.9 0 1 1 3.9 3.1c-.8.4-1.1 1-1.1 1.9" />
              <path d="M10 15.4h.01" />
            </svg>
          </div>
          <div className="min-w-0 pr-6">
            <h2 id="question-modal-title" className="text-sm font-semibold text-zinc-100">The agent has a question</h2>
            <p className="mt-1 text-sm text-zinc-300">{request.question}</p>
          </div>
        </div>

        {request.options.length > 0 && (
          <div className="mb-4 flex flex-wrap gap-2">
            {request.options.map((opt) => (
              <button
                key={opt}
                onClick={() => onAnswer(opt)}
                className="rounded-xl border border-white/10 bg-white/[0.02] px-4 py-2 text-sm text-zinc-200 transition-all duration-200 hover:border-violet-500/50 hover:bg-violet-500/10 hover:text-violet-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 active:scale-95"
              >
                {opt}
              </button>
            ))}
          </div>
        )}

        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            {files.length > 0 && (
              <div className="absolute bottom-full left-0 right-0 z-10 mb-2 max-h-56 animate-fade-up overflow-y-auto rounded-xl border border-white/10 bg-zinc-900 p-1.5 shadow-2xl shadow-black/50">
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
            <input
              ref={inputRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onInputKeyDown}
              placeholder="type an answer, or @ to reference a file…"
              aria-label="free answer"
              className="w-full rounded-xl bg-white/5 px-4 py-2.5 text-sm text-zinc-100 outline-none ring-1 ring-white/10 transition-all duration-200 placeholder:text-zinc-600 focus:bg-white/[0.07] focus:ring-violet-500/40"
            />
          </div>
          <button
            onClick={submit}
            disabled={!text.trim()}
            className="rounded-xl bg-gradient-to-r from-violet-500 to-cyan-500 px-4 py-2.5 text-sm font-medium text-white shadow-lg shadow-violet-500/10 transition-all duration-200 hover:scale-[1.03] hover:shadow-[0_0_24px_rgba(167,139,250,0.35)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 active:scale-95 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:scale-100 disabled:hover:shadow-none"
          >
            Answer
          </button>
        </div>
      </div>
    </div>
  );
}
