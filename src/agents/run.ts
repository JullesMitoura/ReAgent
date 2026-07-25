/**
 * Resolve and run typed agents via the shared tool-loop.
 * Supports fork (inherit system prefix), background (agents_* events), worktree cwd,
 * and resume via send_message (Claude Code continue-vs-spawn).
 */

import { runToolLoop } from "../agent/tool-loop.js";
import { config } from "../config.js";
import { runSubagentStartHooks, runSubagentStopHooks } from "../hooks/runner.js";
import { getLogger } from "../logs.js";
import { formatTaskNotification } from "../prompts/reminders/inject.js";
import { buildSystemPrompt } from "../system-prompt.js";
import { APPLY_PATCH_SCHEMA } from "../tools/apply-patch.js";
import { TOOL_SCHEMAS } from "../tools/index.js";
import { STRUCTURED_OUTPUT_SCHEMA } from "../tools/structured-output.js";
import { currentTurn, runWithTurn } from "../turn-context.js";
import type { ChatMessage, ServerEvent } from "../types.js";
import { builtinAgents } from "./builtin.js";
import { loadDiskAgents } from "./load.js";
import {
  getAgentSession,
  newAgentSessionId,
  registerAgentSession,
  type AgentSession,
} from "./sessions.js";
import type { AgentDefinition, RunAgentOptions } from "./types.js";
import { createAgentWorktree, worktreeHasPendingWork } from "./worktree.js";

export type { RunAgentOptions } from "./types.js";

const log = getLogger("agents.run");

export function allAgents(): AgentDefinition[] {
  const map = new Map<string, AgentDefinition>();
  for (const a of builtinAgents()) map.set(a.agentType, a);
  for (const a of loadDiskAgents()) map.set(a.agentType, a);
  return [...map.values()];
}

export function getAgent(agentType: string): AgentDefinition | undefined {
  return allAgents().find((a) => a.agentType === agentType);
}

function schemasFor(tools: ReadonlySet<string>): object[] {
  const all = [...TOOL_SCHEMAS, APPLY_PATCH_SCHEMA, STRUCTURED_OUTPUT_SCHEMA];
  return all.filter((s) => tools.has((s as { function: { name: string } }).function.name));
}

function safeEmit(ev: ServerEvent): void {
  const ctx = currentTurn();
  if (!ctx?.emit || ctx.cancel.set) return;
  try {
    ctx.emit(ev);
  } catch {
    ctx.cancel.set = true;
  }
}

function enqueueBgNotification(text: string): void {
  const ctx = currentTurn();
  if (ctx?.bgNotifyHost) {
    ctx.bgNotifyHost.pendingBgNotifications.push(text);
  }
}

function withAgentIdFooter(report: string, id: string): string {
  if (report.includes(`(agent-id: ${id})`)) return report;
  return `${report}\n\n(agent-id: ${id} — use send_message to continue this agent)`;
}

async function runAgentSync(opts: RunAgentOptions): Promise<string> {
  const def = getAgent(opts.agentType);
  if (!def) {
    const known = allAgents()
      .map((a) => a.agentType)
      .join(", ");
    return `Error: unknown agent type '${opts.agentType}'. Known: ${known}`;
  }
  runSubagentStartHooks(def.agentType, opts.prompt);
  const allowed = new Set(def.tools);
  const sessionId = opts.sessionId ?? newAgentSessionId();
  let system = def.getSystemPrompt({ title: opts.title ?? opts.agentType });
  if (opts.fork) {
    const parent = opts.parentSystemPrompt ?? buildSystemPrompt();
    system =
      parent +
      "\n\n---\nYou are a FORKED sub-agent. The block above is inherited context. " +
      "Follow the directive below; do not re-explore what the parent already knows.\n---\n\n" +
      system;
  }

  let worktree = null as ReturnType<typeof createAgentWorktree>;
  if (
    opts.cwd ||
    def.isolation === "worktree" ||
    (config.worktreeAgents && opts.agentType === "worker")
  ) {
    worktree = opts.cwd
      ? { path: opts.cwd, branch: "(cwd)", cleanup: () => undefined }
      : createAgentWorktree(opts.title ?? opts.agentType);
  }

  const parentTurn = currentTurn();
  const nestedTurn = parentTurn
    ? {
        ...parentTurn,
        changes: null,
        allowQuestion: false,
        toolRoot: worktree?.path ?? opts.cwd ?? parentTurn.toolRoot ?? null,
        enabledDeferred: new Set(parentTurn.enabledDeferred),
        bgNotifyQueue: [],
        bgNotifyHost: null,
      }
    : undefined;

  // Cleanup destroys the worktree and its branch. There is no automatic
  // merge-back in this project, so when the tree still holds unintegrated work
  // (uncommitted changes, or commits not reachable from root HEAD) we preserve
  // it and surface the path/branch instead of discarding the agent's work.
  let worktreeReleased = false;
  const releaseWorktree = (): string | null => {
    if (!worktree || opts.cwd || worktreeReleased) return null;
    worktreeReleased = true;
    if (worktreeHasPendingWork(worktree)) {
      return (
        `worktree preserved at ${worktree.path} (branch ${worktree.branch}) with uncommitted ` +
        `changes or unmerged commits — integrate manually (e.g. git merge ${worktree.branch}), ` +
        `then remove it with: git worktree remove --force ${worktree.path}`
      );
    }
    worktree.cleanup();
    return null;
  };

  const messages: ChatMessage[] = [
    { role: "system", content: system },
    {
      role: "user",
      content: worktree
        ? `${opts.prompt}\n\n[Isolated worktree cwd: ${worktree.path} — tools resolve relative to this tree.]`
        : opts.prompt,
    },
  ];

  const runBody = async (): Promise<string> => {
    try {
      const report = await runToolLoop({
        messages,
        schemas: schemasFor(allowed),
        maxSteps: def.maxSteps,
        allowedTools: allowed,
        forceSummary: def.forceSummary,
        emptyResult: def.emptyResult,
        doomStyle: def.doomStyle ?? "none",
        onToolStart: opts.onToolStart,
        onToolEnd: opts.onToolEnd,
        shouldAbort: () => Boolean(currentTurn()?.cancel.set),
        refuseMessage:
          def.agentType === "worker"
            ? () =>
                `Error: worker agents may only use these tools: ${[...allowed].sort().join(", ")}`
            : (name) =>
                `Error: agent '${def.agentType}' may only use: ${[...allowed].sort().join(", ")} (refused '${name}')`,
      });
      runSubagentStopHooks(def.agentType, report);
      const preservedNote = releaseWorktree();
      const body =
        worktree && !opts.cwd
          ? `${report}\n\n(${preservedNote ?? `worktree: ${worktree.path}, branch: ${worktree.branch}`})`
          : report;
      registerAgentSession({
        id: sessionId,
        agentType: def.agentType,
        title: opts.title ?? def.agentType,
        messages,
        allowedTools: allowed,
        maxSteps: def.maxSteps,
        forceSummary: def.forceSummary,
        emptyResult: def.emptyResult ?? "(no report)",
        doomStyle: def.doomStyle ?? "none",
        status: "completed",
        updatedAt: Date.now(),
      });
      return opts.sessionFooter === false ? body : withAgentIdFooter(body, sessionId);
    } catch (e) {
      registerAgentSession({
        id: sessionId,
        agentType: def.agentType,
        title: opts.title ?? def.agentType,
        messages,
        allowedTools: allowed,
        maxSteps: def.maxSteps,
        forceSummary: def.forceSummary,
        emptyResult: def.emptyResult ?? "(no report)",
        doomStyle: def.doomStyle ?? "none",
        status: "failed",
        updatedAt: Date.now(),
      });
      throw e;
    } finally {
      // Error paths reach here without releasing; preservation is logged since
      // the note cannot be attached to a report that no longer exists.
      const note = releaseWorktree();
      if (note) log.warning("agent '%s' failed: %s", def.agentType, note);
    }
  };

  if (nestedTurn) return runWithTurn(nestedTurn, runBody);
  return runBody();
}

/**
 * Continues a previously registered agent with a follow-up message (full transcript).
 * Prefer this over a fresh spawn when correcting failures or extending recent work.
 */
export async function continueAgent(agentId: string, message: string): Promise<string> {
  const session = getAgentSession(agentId);
  if (!session) {
    return (
      `Error: unknown agent-id '${agentId}'. ` +
      "Use an id from a prior agent result footer or <task-notification>, or spawn a fresh agent."
    );
  }
  if (!message.trim()) {
    return "Error: send_message requires a non-empty message.";
  }

  session.messages.push({ role: "user", content: message });
  session.status = "running";
  session.updatedAt = Date.now();

  const parentTurn = currentTurn();
  const nestedTurn = parentTurn
    ? {
        ...parentTurn,
        changes: null,
        allowQuestion: false,
        bgNotifyQueue: [],
        bgNotifyHost: null,
      }
    : undefined;

  const runBody = async (): Promise<string> => {
    try {
      const report = await runToolLoop({
        messages: session.messages,
        schemas: schemasFor(session.allowedTools),
        maxSteps: session.maxSteps,
        allowedTools: session.allowedTools,
        forceSummary: session.forceSummary,
        emptyResult: session.emptyResult,
        doomStyle: session.doomStyle,
        shouldAbort: () => Boolean(currentTurn()?.cancel.set),
        refuseMessage: (name) =>
          `Error: agent '${session.agentType}' may only use: ${[...session.allowedTools].sort().join(", ")} (refused '${name}')`,
      });
      runSubagentStopHooks(session.agentType, report);
      session.status = "completed";
      session.updatedAt = Date.now();
      registerAgentSession(session);
      return withAgentIdFooter(report, session.id);
    } catch (e) {
      session.status = "failed";
      session.updatedAt = Date.now();
      registerAgentSession(session);
      throw e;
    }
  };

  if (nestedTurn) return runWithTurn(nestedTurn, runBody);
  return runBody();
}

/** Runs a named agent definition; returns the final report text. */
export async function runAgent(opts: RunAgentOptions): Promise<string> {
  if (opts.background) {
    const id = opts.sessionId ?? newAgentSessionId();
    const title = opts.title ?? opts.agentType;
    const parentCtx = currentTurn();
    safeEmit({ type: "agents_start", agents: [{ id, title }] });
    safeEmit({ type: "agent_update", id, status: "running", detail: "background start" });
    void (async () => {
      const deliver = (text: string): void => {
        if (parentCtx?.bgNotifyHost) {
          parentCtx.bgNotifyHost.pendingBgNotifications.push(text);
        } else {
          enqueueBgNotification(text);
        }
      };
      try {
        const report = await (parentCtx
          ? runWithTurn(parentCtx, () =>
              runAgentSync({ ...opts, background: false, sessionId: id }),
            )
          : runAgentSync({ ...opts, background: false, sessionId: id }));
        safeEmit({
          type: "agent_update",
          id,
          status: "done",
          detail: report.split("\n")[0]?.slice(0, 100),
        });
        safeEmit({ type: "agents_end" });
        deliver(
          formatTaskNotification({
            id,
            title,
            status: "completed",
            summary: `Background agent '${title}' completed`,
            result: report,
          }),
        );
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e);
        safeEmit({
          type: "agent_update",
          id,
          status: "error",
          detail: err,
        });
        safeEmit({ type: "agents_end" });
        deliver(
          formatTaskNotification({
            id,
            title,
            status: "failed",
            summary: `Background agent '${title}' failed: ${err}`,
          }),
        );
      }
    })();
    return (
      `Background agent '${title}' started (id=${id}). ` +
      "Continue other work; do not invent its results. " +
      "Completion arrives as a <task-notification> user message. " +
      `After it finishes, use send_message(to=${id}) to continue it.`
    );
  }
  return runAgentSync(opts);
}

export type { AgentSession };
