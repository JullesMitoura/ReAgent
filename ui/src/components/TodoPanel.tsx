import { useState } from "react";
import { toolActionLabel, toolActionTarget } from "../liveStatus";
import type { AgentBranch, AgentBranchStatus, ChatMessage, Todo } from "../types";

type ToolMsg = Extract<ChatMessage, { role: "tool" }>;

interface ActivityItem {
  tool: ToolMsg;
  target: string;
}

interface ActivityGroup {
  name: string;
  status: "running" | "done";
  items: ActivityItem[];
}

function pathLeaf(target: string): string {
  const cleaned = target.replace(/\\/g, "/");
  const leaf = cleaned.split("/").pop() || cleaned;
  return leaf.length > 36 ? `${leaf.slice(0, 34)}…` : leaf;
}

function formatArgs(args: string): string {
  try {
    return JSON.stringify(JSON.parse(args || "{}"), null, 2);
  } catch {
    return args || "(no args)";
  }
}

/** Collapse consecutive same-tool done actions (chronological → newest groups first). */
function groupToolActivity(tools: ToolMsg[]): ActivityGroup[] {
  const groups: ActivityGroup[] = [];
  for (const m of tools) {
    const target = toolActionTarget(m.name, m.args) || m.name;
    const last = groups[groups.length - 1];
    const canMerge =
      last &&
      last.name === m.name &&
      last.status === "done" &&
      m.status === "done";
    if (canMerge) {
      last.items.push({ tool: m, target });
    } else {
      groups.push({
        name: m.name,
        status: m.status,
        items: [{ tool: m, target }],
      });
    }
  }
  return groups.reverse();
}

function groupNoun(name: string, n: number): string {
  if (name === "read_file") return n === 1 ? "file" : "files";
  if (name === "grep") return n === 1 ? "search" : "searches";
  if (name === "glob") return n === 1 ? "pattern" : "patterns";
  if (name === "bash" || name === "exec_command") return n === 1 ? "command" : "commands";
  if (name === "list_dir") return n === 1 ? "folder" : "folders";
  return n === 1 ? "action" : "actions";
}

function ActivityDetail({ tool }: { tool: ToolMsg }) {
  const argsText = formatArgs(tool.args);
  const result = tool.result?.trim() ?? "";
  return (
    <div className="mt-1 mb-1.5 space-y-1.5 rounded-md border border-white/[0.06] bg-zinc-950/60 px-2 py-1.5">
      <div className="font-mono text-[9px] uppercase tracking-wider text-zinc-600">{tool.name}</div>
      <pre className="max-h-28 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px] leading-snug text-zinc-500">
        {argsText}
      </pre>
      {tool.status === "running" ? (
        <div className="font-mono text-[10px] text-cyan-500/80">running…</div>
      ) : result ? (
        <pre className="max-h-36 overflow-auto whitespace-pre-wrap break-words border-t border-white/[0.04] pt-1.5 font-mono text-[10px] leading-snug text-zinc-400">
          {result}
        </pre>
      ) : (
        <div className="font-mono text-[10px] text-zinc-600">no output</div>
      )}
    </div>
  );
}

function ActivityRow({
  item,
  name,
  running,
  open,
  onToggle,
}: {
  item: ActivityItem;
  name: string;
  running: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const verb = toolActionLabel(name, !running);
  return (
    <li className={`rounded-md ${running && !open ? "bg-cyan-400/[0.06]" : ""} ${open ? "bg-white/[0.03]" : ""}`}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className={`flex w-full cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-white/[0.03] ${
          running && open ? "bg-cyan-400/[0.06]" : ""
        }`}
        title={`${name}${item.target ? ` · ${item.target}` : ""} — click for details`}
      >
        <span
          className={`h-1 w-1 shrink-0 rounded-full ${running ? "animate-pulse bg-cyan-400" : "bg-zinc-600"}`}
          aria-hidden
        />
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] leading-tight">
          <span className={running ? "text-zinc-400" : "text-zinc-500"}>{verb}</span>
          {item.target ? (
            <>
              <span className="text-zinc-700"> · </span>
              <span className={running ? "text-zinc-200" : "text-zinc-400"}>{pathLeaf(item.target)}</span>
            </>
          ) : null}
        </span>
        <span
          className={`shrink-0 text-[9px] text-zinc-600 transition-transform ${open ? "rotate-90" : ""}`}
          aria-hidden
        >
          ▸
        </span>
      </button>
      {open ? (
        <div className="px-1.5 pb-0.5 pl-[11px]">
          <ActivityDetail tool={item.tool} />
        </div>
      ) : null}
    </li>
  );
}

function ActivityFeed({ tools }: { tools: ToolMsg[] }) {
  const groups = groupToolActivity(tools);
  const total = tools.length;
  const [openId, setOpenId] = useState<string | null>(null);
  const [openGroupKey, setOpenGroupKey] = useState<string | null>(null);

  if (total === 0) return null;

  function toggleItem(id: string) {
    setOpenId((prev) => (prev === id ? null : id));
  }

  return (
    <section className="mt-5">
      <div className="mb-2.5 flex items-baseline justify-between gap-2">
        <h3 className="text-[10px] font-semibold uppercase tracking-[0.15em] text-zinc-500">Activity</h3>
        <span className="font-mono text-[10px] tabular-nums text-zinc-600">{total}</span>
      </div>
      <ul className="activity-feed max-h-72 space-y-0.5 overflow-y-auto pr-0.5">
        {groups.map((g) => {
          const running = g.status === "running" || g.items.some((i) => i.tool.status === "running");
          const verb = toolActionLabel(g.name, !running);

          if (g.items.length === 1) {
            const item = g.items[0]!;
            return (
              <ActivityRow
                key={item.tool.id}
                item={item}
                name={g.name}
                running={running}
                open={openId === item.tool.id}
                onToggle={() => toggleItem(item.tool.id)}
              />
            );
          }

          const groupKey = `${g.name}-${g.items[0]!.tool.id}`;
          const groupOpen = openGroupKey === groupKey;

          return (
            <li key={groupKey} className="rounded-md">
              <button
                type="button"
                onClick={() => setOpenGroupKey((prev) => (prev === groupKey ? null : groupKey))}
                aria-expanded={groupOpen}
                className="flex w-full cursor-pointer list-none items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-white/[0.03]"
              >
                <span className="h-1 w-1 shrink-0 rounded-full bg-zinc-600" aria-hidden />
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] leading-tight">
                  <span className="text-zinc-500">{verb}</span>
                  <span className="text-zinc-700"> · </span>
                  <span className="text-zinc-400">
                    {g.items.length} {groupNoun(g.name, g.items.length)}
                  </span>
                </span>
                <span
                  className={`shrink-0 text-[9px] text-zinc-600 transition-transform ${groupOpen ? "rotate-90" : ""}`}
                >
                  ▸
                </span>
              </button>
              {groupOpen ? (
                <ul className="mb-1 ml-[11px] space-y-0.5 border-l border-white/[0.06] pl-1.5">
                  {[...g.items].reverse().map((item) => {
                    const itemRunning = item.tool.status === "running";
                    return (
                      <ActivityRow
                        key={item.tool.id}
                        item={item}
                        name={g.name}
                        running={itemRunning}
                        open={openId === item.tool.id}
                        onToggle={() => toggleItem(item.tool.id)}
                      />
                    );
                  })}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// geometria do grafo: espinha vertical alinhada ao centro dos nós
// (px-1 do nó + metade do círculo de 16px = 12px do início da lista)
const SPINE_LEFT = "left-[11.5px]";
// mesma espinha em % da largura da lista (~248px úteis no painel w-72)
const SPINE_X = 4.84;

/** Nó do grafo: círculo de status + texto, com segmentos da espinha acima/abaixo. */
function TodoNode({
  todo,
  connectUp,
  connectDown,
  live,
}: {
  todo: Todo;
  connectUp: boolean;
  connectDown: boolean;
  live: boolean;
}) {
  const isDone = todo.status === "completed";
  // "in_progress" só é um estado ao vivo; num histórico nada está rodando, então
  // ele volta a ser um passo neutro (sem spinner, sem destaque de execução).
  const isActive = todo.status === "in_progress" && live;
  return (
    <li
      className={`relative flex items-start gap-2.5 rounded-lg px-1 py-1.5 text-sm transition-colors duration-300 ${
        live ? "animate-fade-up" : ""
      } ${isActive ? "bg-cyan-400/[0.06] ring-1 ring-inset ring-cyan-400/10" : ""}`}
    >
      {connectUp && <span aria-hidden="true" className={`absolute ${SPINE_LEFT} top-0 h-2 w-px bg-white/10`} />}
      {connectDown && <span aria-hidden="true" className={`absolute ${SPINE_LEFT} bottom-0 top-6 w-px bg-white/10`} />}
      <span className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center">
        {isDone ? (
          <span
            className={`grid h-4 w-4 place-items-center rounded-full bg-emerald-500/20 text-[10px] text-emerald-400 ring-1 ring-inset ring-emerald-400/30 ${
              live ? "animate-pop-in" : ""
            }`}
          >
            ✓
          </span>
        ) : isActive ? (
          <span className="h-3.5 w-3.5 animate-spin rounded-full border-[1.5px] border-zinc-600 border-t-cyan-400 shadow-[0_0_6px_rgba(34,211,238,0.35)]" />
        ) : (
          <span className="grid h-4 w-4 place-items-center rounded-full border border-zinc-700/80 text-transparent transition-colors duration-300">
            ·
          </span>
        )}
      </span>
      <span
        className={`transition-colors duration-300 ${
          isDone
            ? "text-zinc-500 line-through decoration-zinc-600"
            : isActive
              ? "text-zinc-100"
              : "text-zinc-400"
        }`}
      >
        {todo.content}
      </span>
    </li>
  );
}

function BranchIcon({ status }: { status: AgentBranchStatus }) {
  if (status === "running") {
    return <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-[1.5px] border-zinc-600 border-t-cyan-400" />;
  }
  if (status === "done") {
    return (
      <span className="grid h-3.5 w-3.5 shrink-0 animate-pop-in place-items-center rounded-full bg-emerald-500/20 text-[9px] text-emerald-400 ring-1 ring-inset ring-emerald-400/30">
        ✓
      </span>
    );
  }
  return (
    <span className="grid h-3.5 w-3.5 shrink-0 place-items-center rounded-full bg-red-500/20 text-[9px] text-red-400 ring-1 ring-inset ring-red-400/30">
      ✕
    </span>
  );
}

// Rótulos amigáveis por ferramenta para o detalhe do worker: o backend manda
// "<tool> <alvo>" (ex.: "list_dir output"); viramos "Exploring output". Quando o
// primeiro token não é uma ferramenta conhecida (ex.: o relatório final do
// worker), mantém o texto como veio.
const BRANCH_VERB: Record<string, string> = {
  read_file: "Reading",
  list_dir: "Exploring",
  glob: "Finding files",
  grep: "Searching",
  write_file: "Writing",
  edit_file: "Editing",
  multi_edit: "Editing",
  delete_file: "Deleting",
  apply_patch: "Patching",
  bash: "Running",
};
function prettyDetail(detail: string): string {
  const sp = detail.indexOf(" ");
  const head = sp === -1 ? detail : detail.slice(0, sp);
  const verb = BRANCH_VERB[head];
  if (!verb) return detail;
  const rest = sp === -1 ? "" : detail.slice(sp + 1).trim();
  return rest ? `${verb} ${rest}` : verb;
}

function BranchCard({ branch }: { branch: AgentBranch }) {
  const tone =
    branch.status === "running"
      ? "bg-cyan-400/[0.05] ring-cyan-400/25 shadow-[0_0_10px_rgba(34,211,238,0.12)]"
      : branch.status === "error"
        ? "bg-red-500/[0.06] ring-red-400/25"
        : "bg-white/[0.03] ring-white/10";
  return (
    <div className={`min-w-0 rounded-lg p-1.5 ring-1 ring-inset transition-colors duration-300 ${tone}`}>
      <div className="flex items-center gap-1.5">
        <BranchIcon status={branch.status} />
        <span className="min-w-0 truncate text-[11px] leading-tight text-zinc-300" title={branch.title}>
          {branch.title}
        </span>
      </div>
      {branch.detail && (
        <p className="mt-1 truncate text-[10px] text-zinc-500" title={branch.detail}>
          {prettyDetail(branch.detail)}
        </p>
      )}
    </div>
  );
}

/** Curvas do fork/join: espinha ativa em gradiente ciano/violeta, o resto discreto. */
function ForkPaths({ branches, join, gradId }: { branches: AgentBranch[]; join: boolean; gradId: string }) {
  const n = branches.length;
  return (
    <svg viewBox="0 0 100 20" preserveAspectRatio="none" className="h-4 w-full" aria-hidden="true">
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="rgb(34 211 238 / 0.75)" />
          <stop offset="100%" stopColor="rgb(139 92 246 / 0.75)" />
        </linearGradient>
      </defs>
      {branches.map((b, i) => {
        const c = ((i + 0.5) / n) * 100; // centro da faixa i em %
        const d = join
          ? `M ${c} 0 C ${c} 12, ${SPINE_X} 8, ${SPINE_X} 20`
          : `M ${SPINE_X} 0 C ${SPINE_X} 12, ${c} 8, ${c} 20`;
        return (
          <path
            key={b.id}
            d={d}
            fill="none"
            stroke={b.status === "running" ? `url(#${gradId})` : "rgb(255 255 255 / 0.12)"}
            strokeWidth={1.2}
            vectorEffect="non-scaling-stroke"
          />
        );
      })}
    </svg>
  );
}

/**
 * Fork no grafo. Até 3 agentes: as curvas diverge/converge (bonitas e legíveis).
 * A partir de 4 (o teto é 10): a espinha em N colunas fica ilegível, então
 * usamos um cabeçalho ("N agents in parallel") + grade de 2 colunas que quebra.
 */
function ForkSection({ branches }: { branches: AgentBranch[] }) {
  const running = branches.filter((b) => b.status === "running").length;
  if (branches.length > 3) {
    return (
      <li className="animate-fade-up" aria-label="parallel agents">
        <div className="mb-1.5 flex items-center gap-1.5 pl-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-500">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-gradient-to-r from-cyan-400 to-violet-500" />
          {branches.length} agents in parallel
          {running > 0 && (
            <span className="font-normal normal-case tracking-normal text-zinc-600">· {running} running</span>
          )}
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          {branches.map((b) => (
            <BranchCard key={b.id} branch={b} />
          ))}
        </div>
      </li>
    );
  }
  return (
    <li className="animate-fade-up" aria-label="parallel agents">
      <ForkPaths branches={branches} join={false} gradId="fork-diverge" />
      <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${branches.length}, minmax(0, 1fr))` }}>
        {branches.map((b) => (
          <BranchCard key={b.id} branch={b} />
        ))}
      </div>
      <ForkPaths branches={branches} join={true} gradId="fork-join" />
    </li>
  );
}

export function TodoPanel({
  todos,
  branches = [],
  live,
  messages,
}: {
  todos: Todo[];
  branches?: AgentBranch[];
  /** true enquanto um turno roda; false ao revisar uma sessão do histórico. */
  live: boolean;
  messages: ChatMessage[];
}) {
  const done = todos.filter((t) => t.status === "completed").length;
  const pct = todos.length ? Math.round((done / todos.length) * 100) : 0;

  // ponto do fork: logo após o primeiro todo em andamento; sem ele, após o último nó
  const firstActive = todos.findIndex((t) => t.status === "in_progress");
  const splitAt = firstActive >= 0 ? firstActive + 1 : todos.length;
  const before = todos.slice(0, splitAt);
  const after = todos.slice(splitAt);
  const hasFork = branches.length > 0;
  const toolMessages = messages.filter(
    (m): m is ToolMsg => m.role === "tool",
  );
  const changedFiles = Array.from(
    new Set(
      toolMessages
        .filter((m) =>
          ["write_file", "edit_file", "multi_edit", "delete_file", "apply_patch"].includes(m.name),
        )
        .map((m) => {
          try {
            const parsed = JSON.parse(m.args) as { path?: string };
            return parsed.path ?? m.name;
          } catch {
            return m.name;
          }
        }),
    ),
  );

  return (
    <aside className="glass hidden w-72 shrink-0 flex-col overflow-hidden rounded-2xl lg:flex">
      <div className="flex-1 overflow-y-auto p-5">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.15em] text-zinc-500">Tasks</h3>
          {todos.length > 0 && (
            <span className="font-mono text-[11px] text-zinc-500">
              {done}/{todos.length}
            </span>
          )}
        </div>

        {todos.length > 0 && (
          <div className="mb-4 h-1.5 rounded-full bg-zinc-900/70 ring-1 ring-inset ring-white/10">
            <div
              className={`h-full rounded-full ${
                live
                  ? "bg-gradient-to-r from-cyan-400 to-violet-500 shadow-[0_0_10px_rgba(34,211,238,0.35)] transition-all duration-700 ease-out"
                  : "bg-zinc-600"
              }`}
              style={{ width: `${pct}%` }}
            />
          </div>
        )}

        <ul>
          {before.map((t, i) => (
            <TodoNode
              key={i}
              todo={t}
              live={live}
              connectUp={i > 0}
              connectDown={i < before.length - 1 || hasFork || after.length > 0}
            />
          ))}
          {hasFork && <ForkSection branches={branches} />}
          {after.map((t, i) => (
            <TodoNode key={splitAt + i} todo={t} live={live} connectUp={true} connectDown={i < after.length - 1} />
          ))}
        </ul>

        <ActivityFeed tools={toolMessages} />

        {changedFiles.length > 0 && (
          <section className="mt-5">
            <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-[0.15em] text-zinc-500">
              Files changed
            </h3>
            <div className="space-y-0.5">
              {changedFiles.map((file) => (
                <div
                  key={file}
                  className="truncate rounded-md px-1.5 py-1 font-mono text-[11px] text-zinc-400 hover:bg-white/[0.03] hover:text-zinc-300"
                  title={file}
                >
                  {pathLeaf(file)}
                  <span className="sr-only"> {file}</span>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </aside>
  );
}
