/**
 * QueryEngine: session owner + streaming agentic turn (ex-Agent class).
 * Surfaces call runEvents / submitTurn; this module never prints to the TTY.
 */

import { spawn } from "node:child_process";

import { config } from "../config.js";
import { estimateTokens, packMessages } from "../context.js";
import { getLogger } from "../logs.js";
import * as projectContext from "../project-context.js";
import type { Op } from "../protocol/types.js";
import { Session } from "../session.js";
import { buildSystemPrompt } from "../system-prompt.js";
import { runToolBatches } from "../tools/orchestration.js";
import "./../tools/subagent.js";
import "./../tools/parallel.js";
import "../agents/index.js";
import "../skills/tool.js";
import "../tools/plan-mode.js";
import "../tools/send-message.js";
import "../tools/tool-search.js";
import "../tools/workflow.js";
import { getTodos, setTodos as setTodosFromSession } from "../tools/todo.js";
import { currentTurn } from "../turn-context.js";
import type { ChatMessage, EmitFn } from "../types.js";

import {
  runSessionStartHooks,
  runUserPromptSubmitHooks,
} from "../hooks/runner.js";

import { compactSession, hardTruncate, sanitizeMessages } from "./compact.js";
import { runQueryLoop } from "./query.js";
import { streamCompletion, trackUsage, type StreamToolCall, type UsageLike } from "./stream.js";
import { STATUS_COMPACTING, STATUS_STEERED } from "./status.js";

const log = getLogger("agent");
const NOTIFY_MESSAGE_TAIL = 200;

export class Agent {
  session: Session;
  private contextEnsured = false;

  constructor(session?: Session) {
    this.session = session ?? Session.new();
    if (this.session.messages.length === 0) {
      this.session.messages = [{ role: "system", content: buildSystemPrompt() }];
    }
    setTodosFromSession(this.session.todos);
  }

  get messages(): ChatMessage[] {
    return this.session.messages;
  }

  reset(): void {
    this.session = Session.new();
    this.session.messages = [{ role: "system", content: buildSystemPrompt() }];
    setTodosFromSession([]);
    this.contextEnsured = false;
  }

  /**
   * Protocol entry: maps Op → core action. Surfaces prefer this over
   * calling runEvents / compact directly when migrating.
   */
  async submitTurn(op: Op, emit: EmitFn): Promise<string | void> {
    switch (op.type) {
      case "user_input":
        return this.runEvents(op.text, emit);
      case "compact":
        emit({ type: "status", text: STATUS_COMPACTING });
        await this.compact();
        return;
      case "steer": {
        const q = currentTurn()?.steerQueue;
        if (q) q.push(op.text);
        return;
      }
      case "interrupt": {
        const ctx = currentTurn();
        if (ctx) ctx.cancel.set = true;
        return;
      }
    }
  }

  async runEvents(userInput: string, emit: EmitFn): Promise<string> {
    const wrapped = emit;
    this.sanitize();
    if (!this.contextEnsured) {
      const fresh = !this.messages.some((m) => m.role !== "system");
      if (fresh) {
        await projectContext.ensure(wrapped);
      }
      try {
        const start = runSessionStartHooks(fresh ? "startup" : "resume");
        if (start.additionalContext) {
          this.messages.push({
            role: "user",
            content: `<system-reminder>SessionStart hook context:\n${start.additionalContext}</system-reminder>`,
          });
        }
      } catch {
        // hooks must never break the turn
      }
      this.contextEnsured = true;
    }
    if (this.messages.length > 0 && this.messages[0]!.role === "system") {
      this.messages[0] = { role: "system", content: buildSystemPrompt() };
    }
    log.info("turn start: user_input_len=%d", userInput.length);
    currentTurn()?.changes?.startTurn();
    const turn = currentTurn();
    if (turn) {
      turn.emit = wrapped;
      turn.bgNotifyHost = this.session;
    }
    const historyTokens = Math.max(
      this.session.usage.last_prompt_tokens ?? 0,
      estimateTokens(packMessages(this.messages)),
    );
    const incomingTokens = estimateTokens([{ role: "user", content: userInput }]);
    if (historyTokens + incomingTokens > config.compactThreshold) {
      wrapped({ type: "status", text: STATUS_COMPACTING });
      await this.compact();
    }
    if (!this.session.title) {
      this.session.title = userInput.slice(0, 60);
    }
    this.messages.push({ role: "user", content: userInput });
    try {
      const submit = runUserPromptSubmitHooks(userInput);
      if (submit.additionalContext) {
        this.messages.push({
          role: "user",
          content: `<system-reminder>UserPromptSubmit hook context:\n${submit.additionalContext}</system-reminder>`,
        });
      }
    } catch {
      // hooks must never break the turn
    }

    try {
      return await runQueryLoop(this, userInput, wrapped);
    } finally {
      const safeEmit: EmitFn = (ev) => {
        try {
          wrapped(ev);
        } catch {
          // best-effort inside the finally
        }
      };
      this.drainSteering(safeEmit);
      this.session.todos = getTodos();
      this.session.save();
      this.notifyTurnComplete();
    }
  }

  drainSteering(emit: EmitFn): number {
    const q = currentTurn()?.steerQueue;
    if (!q) return 0;
    let drained = 0;
    while (q.length > 0) {
      const text = q.shift()!;
      this.messages.push({ role: "user", content: text });
      drained += 1;
      emit({ type: "status", text: STATUS_STEERED });
    }
    return drained;
  }

  notifyTurnComplete(): void {
    if (!config.notifyCommand.length) return;
    let last = "";
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i]!;
      if (m.role === "assistant" && m.content) {
        last = String(m.content).slice(-NOTIFY_MESSAGE_TAIL);
        break;
      }
    }
    const payload = {
      type: "turn-complete",
      "session-id": this.session.id,
      title: this.session.title,
      "last-assistant-message": last,
    };
    try {
      const [cmd, ...args] = config.notifyCommand;
      const child = spawn(cmd!, [...args, JSON.stringify(payload)], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
    } catch (exc) {
      log.warning("notify command failed: %s", String(exc));
    }
  }

  sanitize(): void {
    sanitizeMessages(this.session.messages);
  }

  /** Runs a batch of concurrency-safe tool calls in parallel; used both in the live round-dispatch path and by tests. */
  async dispatchParallel(toolCalls: StreamToolCall[]): Promise<Record<string, string>> {
    return runToolBatches(
      toolCalls.map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: { name: tc.name, arguments: tc.arguments },
      })),
    );
  }

  async streamCompletion(
    onToken: (text: string) => void,
    schemas?: object[],
    onToolReady?: (tc: StreamToolCall) => void,
  ) {
    return streamCompletion(this.messages, onToken, schemas, onToolReady);
  }

  trackUsage(usage: UsageLike | null): void {
    trackUsage(this.session.usage, usage, this.messages);
  }

  async compact(_emit?: EmitFn | null): Promise<void> {
    return compactSession(this.session, _emit);
  }

  hardTruncate(keep?: number, budget?: number | null): void {
    hardTruncate(this.session, keep, budget ?? null);
  }
}
