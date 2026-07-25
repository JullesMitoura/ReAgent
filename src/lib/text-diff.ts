/**
 * Pure line-based unified diff (a TypeScript port of the relevant slice of
 * Python's difflib: SequenceMatcher's matching-blocks algorithm plus
 * unified_diff's hunk grouping/formatting). Originally written for
 * tools/apply_patch.py's confirmation preview; shared here so every tool that
 * needs to show the user "what would change" (write_file/edit_file/multi_edit
 * in tools/files.ts, apply_patch in tools/apply-patch.ts) produces the exact
 * same diff shape, which the front-end (PermissionModal's DiffPreview) parses
 * by line prefix ('+'/'-'/' '/'@@') to color additions/removals/context.
 *
 * Layering rule: lib/* imports nothing from the project.
 */

type MatchBlock = [number, number, number];
type OpTag = "replace" | "delete" | "insert" | "equal";
type Opcode = [OpTag, number, number, number, number];

/** Splits on newline variants, without keeping the line breaks (no trailing empty element). */
export function splitDiffLines(s: string): string[] {
  if (!s) return [];
  const parts = s.split(/\r\n|\r|\n/);
  if (parts[parts.length - 1] === "") parts.pop();
  return parts;
}

function findLongestMatch(
  a: string[],
  b: string[],
  b2j: Map<string, number[]>,
  alo: number,
  ahi: number,
  blo: number,
  bhi: number,
): MatchBlock {
  let besti = alo;
  let bestj = blo;
  let bestsize = 0;
  let j2len = new Map<number, number>();
  for (let i = alo; i < ahi; i++) {
    const newj2len = new Map<number, number>();
    for (const j of b2j.get(a[i]!) ?? []) {
      if (j < blo) continue;
      if (j >= bhi) break;
      const k = (j2len.get(j - 1) ?? 0) + 1;
      newj2len.set(j, k);
      if (k > bestsize) {
        besti = i - k + 1;
        bestj = j - k + 1;
        bestsize = k;
      }
    }
    j2len = newj2len;
  }
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
  return [besti, bestj, bestsize];
}

function getMatchingBlocks(a: string[], b: string[]): MatchBlock[] {
  const b2j = new Map<string, number[]>();
  b.forEach((elt, idx) => {
    const list = b2j.get(elt);
    if (list) list.push(idx);
    else b2j.set(elt, [idx]);
  });
  // difflib's autojunk: "popular" elements leave the index in large blocks
  if (b.length >= 200) {
    const ntest = Math.floor(b.length / 100) + 1;
    for (const [elt, idxs] of [...b2j.entries()]) {
      if (idxs.length > ntest) b2j.delete(elt);
    }
  }
  const la = a.length;
  const lb = b.length;
  const queue: [number, number, number, number][] = [[0, la, 0, lb]];
  const matching: MatchBlock[] = [];
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop()!;
    const [i, j, k] = findLongestMatch(a, b, b2j, alo, ahi, blo, bhi);
    if (k) {
      matching.push([i, j, k]);
      if (alo < i && blo < j) queue.push([alo, i, blo, j]);
      if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
    }
  }
  matching.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
  let i1 = 0;
  let j1 = 0;
  let k1 = 0;
  const nonAdjacent: MatchBlock[] = [];
  for (const [i2, j2, k2] of matching) {
    if (i1 + k1 === i2 && j1 + k1 === j2) {
      k1 += k2;
    } else {
      if (k1) nonAdjacent.push([i1, j1, k1]);
      i1 = i2;
      j1 = j2;
      k1 = k2;
    }
  }
  if (k1) nonAdjacent.push([i1, j1, k1]);
  nonAdjacent.push([la, lb, 0]);
  return nonAdjacent;
}

function getOpcodes(a: string[], b: string[]): Opcode[] {
  let i = 0;
  let j = 0;
  const answer: Opcode[] = [];
  for (const [ai, bj, size] of getMatchingBlocks(a, b)) {
    let tag: OpTag | "" = "";
    if (i < ai && j < bj) tag = "replace";
    else if (i < ai) tag = "delete";
    else if (j < bj) tag = "insert";
    if (tag) answer.push([tag, i, ai, j, bj]);
    i = ai + size;
    j = bj + size;
    if (size) answer.push(["equal", ai, i, bj, j]);
  }
  return answer;
}

function groupedOpcodes(a: string[], b: string[], n = 3): Opcode[][] {
  let codes = getOpcodes(a, b);
  if (!codes.length) codes = [["equal", 0, 1, 0, 1]];
  if (codes[0]![0] === "equal") {
    const [tag, i1, i2, j1, j2] = codes[0]!;
    codes[0] = [tag, Math.max(i1, i2 - n), i2, Math.max(j1, j2 - n), j2];
  }
  const lastIdx = codes.length - 1;
  if (codes[lastIdx]![0] === "equal") {
    const [tag, i1, i2, j1, j2] = codes[lastIdx]!;
    codes[lastIdx] = [tag, i1, Math.min(i2, i1 + n), j1, Math.min(j2, j1 + n)];
  }
  const nn = n + n;
  const groups: Opcode[][] = [];
  let group: Opcode[] = [];
  for (const code of codes) {
    let [tag, i1, i2, j1, j2] = code;
    // end of a group: too-large "equal" context breaks the hunk in two
    if (tag === "equal" && i2 - i1 > nn) {
      group.push([tag, i1, Math.min(i2, i1 + n), j1, Math.min(j2, j1 + n)]);
      groups.push(group);
      group = [];
      i1 = Math.max(i1, i2 - n);
      j1 = Math.max(j1, j2 - n);
    }
    group.push([tag, i1, i2, j1, j2]);
  }
  if (group.length && !(group.length === 1 && group[0]![0] === "equal")) groups.push(group);
  return groups;
}

function formatRangeUnified(start: number, stop: number): string {
  let beginning = start + 1;
  const length = stop - start;
  if (length === 1) return String(beginning);
  if (!length) beginning -= 1;
  return `${beginning},${length}`;
}

/**
 * Unified-diff lines for a and b: '--- fromfile'/'+++ tofile' headers, '@@
 * -l,s +l,s @@' hunk markers, then ' '/'-'/'+' prefixed lines (context,
 * removal, addition). Empty array when a and b are identical (no header, no
 * hunks: nothing changed).
 */
export function unifiedDiff(a: string[], b: string[], fromfile: string, tofile: string): string[] {
  const out: string[] = [];
  let started = false;
  for (const group of groupedOpcodes(a, b)) {
    if (!started) {
      started = true;
      out.push(`--- ${fromfile}`);
      out.push(`+++ ${tofile}`);
    }
    const first = group[0]!;
    const last = group[group.length - 1]!;
    const file1Range = formatRangeUnified(first[1], last[2]);
    const file2Range = formatRangeUnified(first[3], last[4]);
    out.push(`@@ -${file1Range} +${file2Range} @@`);
    for (const [tag, i1, i2, j1, j2] of group) {
      if (tag === "equal") {
        for (const line of a.slice(i1, i2)) out.push(" " + line);
        continue;
      }
      if (tag === "replace" || tag === "delete") {
        for (const line of a.slice(i1, i2)) out.push("-" + line);
      }
      if (tag === "replace" || tag === "insert") {
        for (const line of b.slice(j1, j2)) out.push("+" + line);
      }
    }
  }
  return out;
}

/**
 * Unified diff of two whole texts, for a permission-prompt preview. Bounded to
 * `limit` diff lines (a "... (N more diff lines)" marker replaces the rest) so
 * a huge change never floods the prompt or the SSE payload.
 */
export function diffPreview(
  before: string,
  after: string,
  relFrom: string,
  relTo: string,
  limit = 60,
): string {
  let diff = unifiedDiff(splitDiffLines(before), splitDiffLines(after), relFrom, relTo);
  if (diff.length > limit) {
    const hidden = diff.length - limit;
    diff = [...diff.slice(0, limit), `... (${hidden} more diff lines)`];
  }
  return diff.join("\n");
}
