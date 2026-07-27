/**
 * Microcompaction: before paying for a full summarize,
 * destructively clear the content of OLD tool results in the persisted history.
 * Unlike packMessages (a per-request view), this rewrites session.messages, so
 * the reclaimed space survives across turns and reduces what a later full
 * compaction has to summarize. Message structure is never altered: only the
 * `content` of old tool messages is replaced, so the assistant.tool_calls ↔
 * tool pairing stays valid.
 */

import { config } from "../config.js";
import { estimateTokens, packMessages } from "../context.js";
import { getLogger } from "../logs.js";
import type { ChatMessage } from "../types.js";
import type { Session } from "../session.js";

const log = getLogger("agent.microcompact");

/** History share of compactThreshold beyond which microcompaction kicks in. */
const MICROCOMPACT_RATIO = 0.6;

/** The most recent tool results are always left intact. */
export const MICROCOMPACT_KEEP_RECENT = 10;

/** Tool results at or below this size are never worth clearing. */
export const MICROCOMPACT_MIN_CHARS = 1000;

export const MICROCOMPACT_NOTE =
  "[Old tool result content cleared to save context. Re-run the tool if you need it again.]";

/**
 * Clears the content of old, large tool results IN PLACE. The last
 * `keepRecent` tool messages stay intact; earlier ones larger than
 * MICROCOMPACT_MIN_CHARS have their content replaced by MICROCOMPACT_NOTE.
 * Idempotent (already-cleared results are below the size floor). Returns the
 * number of results cleared.
 */
export function microcompactMessages(
  messages: ChatMessage[],
  keepRecent: number = MICROCOMPACT_KEEP_RECENT,
): number {
  let seenTools = 0;
  let cleared = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "tool") continue;
    seenTools += 1;
    if (seenTools <= keepRecent) continue;
    const content = m.content;
    if (typeof content !== "string" || content.length <= MICROCOMPACT_MIN_CHARS) continue;
    m.content = MICROCOMPACT_NOTE;
    cleared += 1;
  }
  return cleared;
}

/**
 * Runs microcompaction when the history crosses the soft threshold
 * (MICROCOMPACT_RATIO of compactThreshold). Refreshes last_prompt_tokens after
 * clearing (like hardTruncate does) so the caller's full-compact check sees the
 * reclaimed space. Returns true when anything was cleared.
 */
export function microcompactIfNeeded(session: Session): boolean {
  const soft = Math.floor(config.compactThreshold * MICROCOMPACT_RATIO);
  if (estimateTokens(packMessages(session.messages)) <= soft) return false;
  const cleared = microcompactMessages(session.messages);
  if (cleared === 0) return false;
  session.usage.last_prompt_tokens = estimateTokens(packMessages(session.messages));
  session.save();
  log.info("microcompact: cleared %d old tool results", cleared);
  return true;
}
