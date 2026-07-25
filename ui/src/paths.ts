/** Encurta um caminho absoluto: o home vira ~ (macOS, Linux e Windows). */
export function prettyPath(p: string): string {
  if (!p) return "";
  return p
    .replace(/^\/Users\/[^/]+/, "~")
    .replace(/^\/home\/[^/]+/, "~")
    .replace(/^[A-Za-z]:\\Users\\[^\\]+/, "~");
}
