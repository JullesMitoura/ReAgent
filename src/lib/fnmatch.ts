// Faithful port of CPython's fnmatch (Lib/fnmatch.py, translate) to RegExp.
// fnmatch semantics, NOT path glob: "*" crosses "/" ("src/*" matches
// "src/a/b"), "?" matches any single character, and "[seq]"/"[!seq]" are classes.
// Keeps .reagent/permissions.json bit-compatible with Python installs.
//
// Assumed differences of the target runtime (macOS/Linux): os.path.normcase is
// identity on POSIX, so fnmatch === fnmatchcase; characters outside the BMP
// count as two UTF-16 units for "?" and ranges (pathological cases).

const STAR = Symbol("star");

// Escape a literal character for RegExp (practical equivalent of re.escape).
const RE_SPECIALS = new Set([
  ".", "^", "$", "*", "+", "?", "(", ")", "[", "]", "{", "}", "|", "\\",
]);

function escapeLiteral(c: string): string {
  return RE_SPECIALS.has(c) ? "\\" + c : c;
}

/**
 * Translate an fnmatch pattern to anchored RegExp source.
 * Equivalent to Python's "(?s:...)\Z": here "." becomes "[^]" (matches newline
 * without needing the s flag) and the anchor is "^(?:...)$" (JS "$" is absolute end).
 */
export function translate(pat: string): string {
  const res: (string | typeof STAR)[] = [];
  let i = 0;
  const n = pat.length;
  while (i < n) {
    const c = pat.charAt(i);
    i += 1;
    if (c === "*") {
      // consecutive "*" collapse into one
      if (res.length === 0 || res[res.length - 1] !== STAR) res.push(STAR);
    } else if (c === "?") {
      res.push("[^]");
    } else if (c === "[") {
      let j = i;
      if (j < n && pat.charAt(j) === "!") j += 1;
      if (j < n && pat.charAt(j) === "]") j += 1;
      while (j < n && pat.charAt(j) !== "]") j += 1;
      if (j >= n) {
        // "[" without a close: literal
        res.push("\\[");
      } else {
        let stuff: string;
        const inner = pat.slice(i, j);
        if (!inner.includes("-")) {
          stuff = inner.replace(/\\/g, "\\\\");
        } else {
          // split the chunks around range "-", as in CPython
          const chunks: string[] = [];
          let k = pat.charAt(i) === "!" ? i + 2 : i + 1;
          for (;;) {
            const idx = pat.indexOf("-", k);
            if (idx < 0 || idx >= j) break;
            chunks.push(pat.slice(i, idx));
            i = idx + 1;
            k = idx + 3;
          }
          const chunk = pat.slice(i, j);
          if (chunk) {
            chunks.push(chunk);
          } else {
            const last = chunks.length - 1;
            chunks[last] = (chunks[last] ?? "") + "-";
          }
          // remove empty ranges (invalid in RegExp)
          for (let k2 = chunks.length - 1; k2 > 0; k2--) {
            const prev = chunks[k2 - 1] ?? "";
            const cur = chunks[k2] ?? "";
            if (prev.charAt(prev.length - 1) > cur.charAt(0)) {
              chunks[k2 - 1] = prev.slice(0, -1) + cur.slice(1);
              chunks.splice(k2, 1);
            }
          }
          stuff = chunks
            .map((s) => s.replace(/\\/g, "\\\\").replace(/-/g, "\\-"))
            .join("-");
        }
        // escape set operators (&&, ~~, ||)
        stuff = stuff.replace(/([&~|])/g, "\\$1");
        i = j + 1;
        if (stuff === "") {
          // empty class: never matches
          res.push("(?!)");
        } else if (stuff === "!") {
          // empty negated class: matches any character
          res.push("[^]");
        } else {
          if (stuff.startsWith("!")) stuff = "^" + stuff.slice(1);
          else if (stuff.startsWith("^") || stuff.startsWith("[")) stuff = "\\" + stuff;
          // "]" only appears as the first character of the class (the scan stops
          // at the next "]"); Python's re accepts it as a literal in that
          // position, JS RegExp requires an escape
          stuff = stuff.replace(/\]/g, "\\]");
          res.push(`[${stuff}]`);
        }
      }
    } else {
      res.push(escapeLiteral(c));
    }
  }
  // STAR becomes greedy "[^]*": matches the same set of strings as CPython's
  // atomic-group form (only the backtracking cost differs)
  const body = res.map((part) => (part === STAR ? "[^]*" : part)).join("");
  return `^(?:${body})$`;
}

// Cache of compiled patterns (mirrors CPython's lru_cache(256)).
const cache = new Map<string, RegExp>();

function compiled(pattern: string): RegExp {
  let re = cache.get(pattern);
  if (!re) {
    if (cache.size >= 256) cache.clear();
    re = new RegExp(translate(pattern));
    cache.set(pattern, re);
  }
  return re;
}

/** Python's fnmatch.fnmatchcase: case-sensitive match, no normcase. */
export function fnmatchcase(name: string, pattern: string): boolean {
  return compiled(pattern).test(name);
}

/** Python's fnmatch.fnmatch; on POSIX normcase is identity. */
export function fnmatch(name: string, pattern: string): boolean {
  return fnmatchcase(name, pattern);
}
