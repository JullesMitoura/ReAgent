/**
 * Protocol façade: Ops submitted by CLI/server surfaces; Events are the
 * existing ServerEvent wire contract (unchanged for the React front).
 *
 * Surfaces translate I/O ↔ Op/Event; the agent core never owns the terminal
 * or HTTP (Codex-style separation).
 */

import type { ServerEvent } from "../types.js";

/** Operations a surface can submit to the agent core. */
export type Op =
  | { type: "user_input"; text: string }
  | { type: "interrupt" }
  | { type: "steer"; text: string }
  | { type: "compact" };

export type OpType = Op["type"];

/** Wire events consumed by CLI renderers and the HTTP/SSE front. */
export type Event = ServerEvent;
export type EventType = ServerEvent["type"];

/** Correlate a submission with its event stream (Codex Submission.id pattern). */
export interface Submission {
  id: string;
  op: Op;
}

let _submissionCounter = 0;

/** Allocates a unique submission id for this process. */
export function nextSubmissionId(): string {
  _submissionCounter += 1;
  return `sub_${Date.now().toString(36)}_${_submissionCounter}`;
}
