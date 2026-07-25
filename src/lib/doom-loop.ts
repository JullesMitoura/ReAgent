/**
 * Doom-loop breaker: the same tool called N times in a row with
 * byte-identical arguments is a loop that only burns tokens. Single helper for
 * the agent's main loop and the parallel_agents workers (same detection,
 * messages with different tails, copied from Python).
 *
 * Layering rule: lib/* imports nothing from the project.
 */

export const DOOM_LOOP_THRESHOLD = 3;

/** Message from the agent's main loop (agent.py, literal). */
export function doomLoopMessage(name: string): string {
  return (
    `Error: this exact ${name} call was repeated ` +
    `${DOOM_LOOP_THRESHOLD} times in a row with identical arguments; ` +
    "the result will not change. Do not repeat it. Reassess your " +
    "approach, or ask the user with the question tool."
  );
}

/** Message from the parallel_agents workers (parallel.py, literal). */
export function doomLoopWorkerMessage(name: string): string {
  return (
    `Error: this exact ${name} call was repeated ${DOOM_LOOP_THRESHOLD} times ` +
    "in a row with identical arguments; the result will not change. " +
    "Change your approach or finish with your report."
  );
}

/**
 * Detector with the same semantics as Python: signature history of the whole
 * turn; fires when the last `threshold` entries are identical to the current
 * call. A different call breaks the sequence.
 */
export class DoomLoopDetector {
  private readonly threshold: number;
  private readonly history: string[] = [];

  constructor(threshold: number = DOOM_LOOP_THRESHOLD) {
    this.threshold = threshold;
  }

  record(name: string, argumentsJson: string): boolean {
    const signature = JSON.stringify([name, argumentsJson]);
    this.history.push(signature);
    if (this.history.length < this.threshold) return false;
    return this.history.slice(-this.threshold).every((s) => s === signature);
  }
}
