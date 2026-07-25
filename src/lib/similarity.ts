/**
 * Faithful port of difflib.SequenceMatcher.ratio() (Ratcliff-Obershelp, gestalt
 * matching with recursive find_longest_match) and of difflib.get_close_matches.
 *
 * Do NOT use Levenshtein here: the consuming thresholds (0.7 for the edit-cascade
 * block anchor, 0.6 for filename suggestions) were calibrated against difflib's
 * ratio and would change in practice.
 *
 * Fidelity:
 * - operates on code points (Array.from), as Python operates on str;
 * - reproduces difflib's autojunk=True default: in b sequences with >= 200
 *   elements, "popular" elements (> n/100 + 1 occurrences) drop out of the
 *   b2j index (but stay valid when extending the ends, as in the original);
 * - isjunk=None (used across the whole repo): bjunk is always empty, so the
 *   junk-extension phases of find_longest_match collapse into the direct extension.
 */

interface Match {
  i: number;
  j: number;
  size: number;
}

class SequenceMatcher {
  private a: string[] = [];
  private b: string[] = [];
  private b2j = new Map<string, number[]>();

  setSeq1(a: string): void {
    this.a = Array.from(a);
  }

  setSeq2(b: string): void {
    this.b = Array.from(b);
    this.chainB();
  }

  // mirror of __chain_b: positions per element + autojunk pruning
  private chainB(): void {
    const b = this.b;
    const b2j = new Map<string, number[]>();
    for (let i = 0; i < b.length; i++) {
      const elt = b[i]!;
      const idxs = b2j.get(elt);
      if (idxs !== undefined) idxs.push(i);
      else b2j.set(elt, [i]);
    }
    const n = b.length;
    if (n >= 200) {
      const ntest = Math.floor(n / 100) + 1;
      const popular: string[] = [];
      for (const [elt, idxs] of b2j) {
        if (idxs.length > ntest) popular.push(elt);
      }
      for (const elt of popular) b2j.delete(elt);
    }
    this.b2j = b2j;
  }

  // mirror of find_longest_match (with isjunk=None there are no junk phases)
  private findLongestMatch(alo: number, ahi: number, blo: number, bhi: number): Match {
    const { a, b, b2j } = this;
    let besti = alo;
    let bestj = blo;
    let bestsize = 0;
    let j2len = new Map<number, number>();
    for (let i = alo; i < ahi; i++) {
      const newj2len = new Map<number, number>();
      const js = b2j.get(a[i]!);
      if (js !== undefined) {
        for (const j of js) {
          if (j < blo) continue;
          if (j >= bhi) break; // indices in ascending order, as in Python
          const k = (j2len.get(j - 1) ?? 0) + 1;
          newj2len.set(j, k);
          if (k > bestsize) {
            besti = i - k + 1;
            bestj = j - k + 1;
            bestsize = k;
          }
        }
      }
      j2len = newj2len;
    }
    // extend the ends: compare elements directly (independent of b2j, so it
    // crosses the "popular" elements pruned by autojunk, as in difflib)
    while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) {
      besti -= 1;
      bestj -= 1;
      bestsize += 1;
    }
    while (
      besti + bestsize < ahi &&
      bestj + bestsize < bhi &&
      a[besti + bestsize] === b[bestj + bestsize]
    ) {
      bestsize += 1;
    }
    return { i: besti, j: bestj, size: bestsize };
  }

  // sum of matched blocks (get_matching_blocks; difflib's merge of adjacent
  // blocks does not change the sum, so it is omitted)
  ratio(): number {
    const la = this.a.length;
    const lb = this.b.length;
    let matches = 0;
    const queue: [number, number, number, number][] = [[0, la, 0, lb]];
    while (queue.length > 0) {
      const [alo, ahi, blo, bhi] = queue.pop()!;
      const m = this.findLongestMatch(alo, ahi, blo, bhi);
      if (m.size > 0) {
        matches += m.size;
        if (alo < m.i && blo < m.j) queue.push([alo, m.i, blo, m.j]);
        if (m.i + m.size < ahi && m.j + m.size < bhi) {
          queue.push([m.i + m.size, ahi, m.j + m.size, bhi]);
        }
      }
    }
    const length = la + lb;
    return length > 0 ? (2.0 * matches) / length : 1.0;
  }
}

/** Equivalent of difflib.SequenceMatcher(None, a, b).ratio(). */
export function ratio(a: string, b: string): number {
  const sm = new SequenceMatcher();
  sm.setSeq2(b);
  sm.setSeq1(a);
  return sm.ratio();
}

/**
 * Equivalent of difflib.get_close_matches(word, possibilities, n, cutoff).
 * Score ties follow Python's heapq.nlargest: larger string first.
 */
export function getCloseMatches(
  word: string,
  possibilities: Iterable<string>,
  n = 3,
  cutoff = 0.6,
): string[] {
  if (!(n > 0)) throw new Error(`n must be > 0: ${n}`);
  if (!(cutoff >= 0.0 && cutoff <= 1.0)) {
    throw new Error(`cutoff must be in [0.0, 1.0]: ${cutoff}`);
  }
  const sm = new SequenceMatcher();
  sm.setSeq2(word);
  const scored: { score: number; x: string }[] = [];
  for (const x of possibilities) {
    sm.setSeq1(x);
    const r = sm.ratio();
    if (r >= cutoff) scored.push({ score: r, x });
  }
  scored.sort((p, q) => {
    if (q.score !== p.score) return q.score - p.score;
    if (p.x < q.x) return 1;
    if (p.x > q.x) return -1;
    return 0;
  });
  return scored.slice(0, n).map((s) => s.x);
}
