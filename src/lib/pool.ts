/**
 * Bounded-concurrency fan-out (Claude Code's `all(gens, cap)` / Codex's
 * max_concurrent_threads pattern).
 *
 * `Promise.all(items.map(fn))` starts EVERY task at once: 10 parallel workers means
 * 10 simultaneous LLM streams and shells. mapLimit keeps at most `limit` tasks in
 * flight, starting a new one as each finishes, while preserving result order.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const n = items.length;
  const results = new Array<R>(n);
  if (n === 0) return results;
  const cap = Math.max(1, Math.min(limit, n));
  let next = 0;

  async function worker(): Promise<void> {
    // Each worker pulls the next index until the queue drains.
    for (;;) {
      const i = next++;
      if (i >= n) return;
      results[i] = await fn(items[i]!, i);
    }
  }

  await Promise.all(Array.from({ length: cap }, () => worker()));
  return results;
}
