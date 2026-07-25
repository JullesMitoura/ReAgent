import { memo, useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { toolActionLabel, toolActionTarget } from "../liveStatus";
import type { ChatMessage } from "../types";
import { Orb, type OrbTone } from "./Orb";

function Avatar({ tone }: { tone?: OrbTone }) {
  return <Orb className="h-8 w-8" tone={tone} />;
}

/** Code block wrapper with a hover "copy" button (reads the rendered text). */
function CodeBlock({ children }: { children?: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const copy = () => {
    const text = ref.current?.innerText ?? "";
    if (!text) return;
    navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1400);
      },
      () => {},
    );
  };
  return (
    <div className="codeblock group/code relative">
      <button
        type="button"
        onClick={copy}
        aria-label="Copy code"
        className="absolute right-2 top-2 z-10 rounded-md border border-white/10 bg-zinc-900/85 px-2 py-1 font-mono text-[10px] text-zinc-400 opacity-0 backdrop-blur transition-opacity hover:text-zinc-100 focus-visible:opacity-100 focus-visible:outline-none group-hover/code:opacity-100"
      >
        {copied ? "copied" : "copy"}
      </button>
      <pre ref={ref}>{children}</pre>
    </div>
  );
}

const MD_COMPONENTS = { pre: CodeBlock };

/**
 * Reveals `content` progressively at a smooth pace instead of jumping by whole
 * network chunks. Each frame it catches up to the target proportionally to the
 * backlog, so bursts decelerate naturally (ease-out) and the text flows evenly
 * regardless of how the tokens arrive. Respects prefers-reduced-motion.
 */
function useSmoothText(content: string, streaming: boolean): string {
  const [shown, setShown] = useState(streaming ? "" : content);
  const targetRef = useRef(content);
  const lenRef = useRef(shown.length);
  targetRef.current = content;

  useEffect(() => {
    if (!streaming) return; // final/historical message: rendered fully via the return below
    if (lenRef.current > targetRef.current.length) {
      lenRef.current = 0; // target shrank (message reset): restart the reveal
      setShown("");
    }
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let running = true;
    let raf = 0;
    const tick = () => {
      if (!running) return;
      const full = targetRef.current;
      let cur = lenRef.current;
      if (cur < full.length) {
        cur = reduce ? full.length : Math.min(full.length, cur + Math.max(1, Math.ceil((full.length - cur) / 6)));
        lenRef.current = cur;
        setShown(full.slice(0, cur));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      running = false;
      cancelAnimationFrame(raf);
    };
  }, [streaming]);

  return streaming ? shown : content;
}

/* referencias @caminho na mensagem do usuario, mesma regra do input */
const AT_REF_RE = /(?<!\w)@[^\s@]+/g;

/** Realca cada @caminho como um chip, indicando ser um arquivo (igual ao input). */
function renderRefs(text: string) {
  const out: (string | ReactElement)[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(AT_REF_RE)) {
    const start = m.index ?? 0;
    if (start > last) out.push(text.slice(last, start));
    out.push(
      <span key={key++} className="rounded bg-cyan-400/15 px-1 font-medium text-cyan-200">
        {m[0]}
      </span>,
    );
    last = start + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// Memoizado por referência de `msg`: durante o streaming apenas a mensagem
// atual muda de identidade, as demais mantêm a mesma referência e nao
// re-renderizam a cada token. Shallow compare (referencia) e exatamente o
// comportamento desejado aqui, pois nenhuma outra prop e passada.
function MessageBase({ msg, avatarTone }: { msg: ChatMessage; avatarTone?: OrbTone }) {
  if (msg.role === "user") {
    return (
      <div className="flex animate-fade-up justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md border border-cyan-500/25 bg-gradient-to-br from-cyan-500/15 via-cyan-500/10 to-violet-500/10 px-4 py-2.5 text-[15px] text-zinc-100 shadow-lg shadow-cyan-950/25">
          <p className="whitespace-pre-wrap">{renderRefs(msg.content)}</p>
        </div>
      </div>
    );
  }

  if (msg.role === "tool") {
    const running = msg.status === "running";
    const label = toolActionLabel(msg.name, !running);
    const target = toolActionTarget(msg.name, msg.args);
    return (
      <details className="group ml-11 animate-fade-up">
        <summary
          className={`glass inline-flex max-w-full cursor-pointer select-none list-none items-center gap-2.5 rounded-full px-3.5 py-1.5 font-mono text-xs shadow-sm shadow-black/20 transition-all duration-200 hover:border-cyan-500/40 hover:bg-zinc-800/70 ${
            running ? "border-cyan-400/25" : ""
          }`}
        >
          {running ? (
            <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-[1.5px] border-zinc-600 border-t-cyan-400" />
          ) : (
            <span className="shrink-0 text-emerald-400">✓</span>
          )}
          <span className={running ? "font-medium text-cyan-200/90" : "text-zinc-300"}>{label}</span>
          {target && <span className="truncate text-zinc-500">{target}</span>}
          <span className="ml-0.5 shrink-0 text-zinc-600 transition-transform duration-200 group-open:rotate-90">▸</span>
        </summary>
        <div className="ml-4 mt-2 animate-fade border-l border-white/10 pl-3">
          <div className="mb-1 font-mono text-[10px] text-zinc-600">
            {msg.name} {msg.args.slice(0, 80)}
          </div>
          {msg.result && (
            <pre className="max-h-48 overflow-auto rounded-xl border border-white/5 bg-zinc-950/80 p-3.5 font-mono text-xs leading-relaxed text-zinc-400 shadow-inner shadow-black/40">
              {msg.result}
            </pre>
          )}
        </div>
      </details>
    );
  }

  if (msg.role === "system") {
    return (
      <div className="ml-11 animate-fade-up font-mono text-xs tracking-wide text-violet-300/75">✦ {msg.content}</div>
    );
  }

  return <AssistantBubble msg={msg} avatarTone={avatarTone} />;
}

/**
 * Assistant reply: orb + markdown, or orb + live status while working.
 * Status: muted gray monospace; three dots cycle in sequence (CLI-style).
 */
function AnimatedEllipsis() {
  return (
    <span className="status-ellipsis" aria-hidden="true">
      <span>.</span>
      <span>.</span>
      <span>.</span>
    </span>
  );
}

/** Linha de status ao vivo (verbo shimmer + detalhe), usada dentro da bolha. */
function StatusLine({ status }: { status: string }) {
  // Strip trailing ellipsis; AnimatedEllipsis owns the dots
  const label = status.replace(/[.…]+$/, "").replace(/ · /g, " · ");
  const sep = label.indexOf(" · ");
  const verb = sep >= 0 ? label.slice(0, sep) : label;
  const detail = sep >= 0 ? label.slice(sep + 3) : "";
  return (
    <p
      className="flex min-w-0 items-baseline gap-1.5 font-mono text-[13px] leading-none text-zinc-500"
      aria-live="polite"
    >
      <span className="shrink-0">
        <span className="shimmer font-medium">{verb}</span>
        <AnimatedEllipsis />
      </span>
      {detail && (
        <span className="truncate text-zinc-600" title={detail}>
          {detail}
        </span>
      )}
    </p>
  );
}

function AssistantBubble({
  msg,
  avatarTone,
}: {
  msg: Extract<ChatMessage, { role: "assistant" }>;
  avatarTone?: OrbTone;
}) {
  const text = useSmoothText(msg.content, !!msg.streaming);
  const thinking = !!msg.streaming && !text;

  return (
    <div className="flex animate-fade-up gap-3">
      <Avatar tone={avatarTone} />
      <div className="markdown min-w-0 flex-1 pt-0.5 text-[15px] leading-relaxed text-zinc-200">
        {thinking ? (
          <div className="pt-1.5">
            <StatusLine status={msg.progress || "Thinking…"} />
          </div>
        ) : (
          <>
            <Markdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[[rehypeHighlight, { ignoreMissing: true }]]}
              components={MD_COMPONENTS}
            >
              {text}
            </Markdown>
            {/* trabalhando após já ter texto (ferramentas, novo raciocínio):
                o status entra NA MESMA bolha, sob o texto — nada de segundo orb */}
            {msg.streaming && text && msg.progress ? (
              <div className="mt-2">
                <StatusLine status={msg.progress} />
              </div>
            ) : (
              msg.streaming &&
              text && (
                <span className="ml-0.5 inline-block h-4 w-2 animate-pulse rounded-sm bg-gradient-to-b from-cyan-400 to-violet-500 align-middle" />
              )
            )}
          </>
        )}
      </div>
    </div>
  );
}

export const Message = memo(MessageBase);

function TypingIndicatorBase({ tone }: { tone?: OrbTone }) {
  return (
    <div className="flex animate-fade-up items-center gap-2 py-1 text-xs text-zinc-400" aria-live="polite">
      <Avatar tone={tone} />
    </div>
  );
}

// Estático: memoizado para nao re-renderizar durante o streaming.
export const TypingIndicator = memo(TypingIndicatorBase);
